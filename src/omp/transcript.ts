import type { SessionView, ToolExecutionEvent, ToolResultView, TranscriptItem, UsageView } from "./api";
import { Emitter } from "./emitter";
import { toModelView } from "./models";
import {
	type AgentMessage,
	type AssistantMessage,
	type BashExecutionMessage,
	isRecord,
	type MessageContent,
	type SessionEvent,
	type SessionState,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
	type UserMessage,
} from "./protocol";

type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type NoticeLevel = "info" | "warning" | "error";

export function emptySessionView(): SessionView {
	return {
		phase: "idle",
		availableThinkingLevels: [],
		isStreaming: false,
		isCompacting: false,
		queue: { steering: [], followUp: [] },
		todos: [],
	};
}

/** Text of `{ type: "text" }` blocks (or a bare string), joined by `separator`. */
function textOf(content: unknown, separator = "\n"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join(separator);
}

function userItem(id: string, message: UserMessage): TranscriptItem {
	const content: MessageContent = message.content;
	const imageCount = Array.isArray(content) ? content.filter(block => block.type === "image").length : 0;
	return { kind: "user", id, text: textOf(content), ...(imageCount > 0 ? { imageCount } : {}) };
}

function usageView(usage: Usage | undefined): UsageView | undefined {
	if (!usage) return undefined;
	const view: UsageView = {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
	};
	if (typeof usage.cost?.total === "number") view.costUsd = usage.cost.total;
	return view;
}

function assistantItem(id: string, message: AssistantMessage, streaming: boolean): AssistantItem {
	const thinking: string[] = [];
	for (const block of message.content ?? []) {
		if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") thinking.push(block.thinking);
	}
	const item: AssistantItem = {
		kind: "assistant",
		id,
		text: textOf(message.content, "\n\n"),
		thinking: thinking.join("\n\n"),
		streaming,
	};
	if (message.model) item.model = message.model;
	if (!streaming) {
		if (message.stopReason) item.stopReason = message.stopReason;
		if (message.errorMessage) item.errorMessage = message.errorMessage;
		const usage = usageView(message.usage);
		if (usage) item.usage = usage;
	}
	return item;
}

function toolResultView(result: unknown, isError: boolean | undefined): ToolResultView {
	const record = isRecord(result) ? result : undefined;
	const view: ToolResultView = {
		text: record ? textOf(record.content) : typeof result === "string" ? result : "",
		isError: isError ?? record?.isError === true,
	};
	if (record && record.details !== undefined) view.details = record.details;
	return view;
}

/** Text carried by a `tool_execution_update.partialResult` or `tool_stream_update.update`, if any. */
function partialText(payload: unknown): string | undefined {
	if (typeof payload === "string") return payload;
	if (isRecord(payload) && Array.isArray(payload.content)) return textOf(payload.content);
	return undefined;
}

/**
 * Map a stored conversation (`get_messages`, `get_subagent_messages`) into
 * transcript items. Tool calls become tool items completed by their results.
 */
export function historyToItems(messages: readonly AgentMessage[]): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const tools = new Map<string, number>();
	messages.forEach((message, index) => {
		const id = `h${index}`;
		switch (message.role) {
			case "user": {
				const user = message as UserMessage;
				if (!user.synthetic) items.push(userItem(id, user));
				return;
			}
			case "assistant": {
				const assistant = message as AssistantMessage;
				items.push(assistantItem(id, assistant, false));
				for (const block of assistant.content ?? []) {
					if (block.type !== "toolCall") continue;
					const call = block as ToolCall;
					tools.set(call.id, items.length);
					items.push({
						kind: "tool",
						id: call.id,
						name: call.name,
						args: call.arguments,
						status: "error",
						result: { text: "No result recorded", isError: true },
						startedAt: assistant.timestamp ?? 0,
					});
				}
				return;
			}
			case "toolResult": {
				const result = message as ToolResultMessage;
				const view = toolResultView(result, result.isError);
				const at = tools.get(result.toolCallId);
				if (at === undefined) return;
				const existing = items[at] as ToolItem;
				items[at] = {
					...existing,
					status: view.isError ? "error" : "done",
					result: view,
					endedAt: result.timestamp,
				};
				return;
			}
			case "bashExecution": {
				const bash = message as BashExecutionMessage;
				items.push({ kind: "command_output", id, text: `$ ${bash.command}\n${bash.output}` });
				return;
			}
		}
	});
	return items;
}

function costOf(messages: readonly AgentMessage[]): number | undefined {
	let total: number | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const cost = (message as AssistantMessage).usage?.cost?.total;
		if (typeof cost === "number") total = (total ?? 0) + cost;
	}
	return total;
}

interface StreamCursor {
	textIndex?: number;
	thinkingIndex?: number;
}

/**
 * Reduces OMP session events and snapshots into the host's {@link SessionView}
 * and transcript.
 */
export class SessionStore {
	#session: SessionView = emptySessionView();
	#items: TranscriptItem[] = [];
	readonly #index = new Map<string, number>();
	readonly #cursors = new Map<string, StreamCursor>();
	#lastAssistantId: string | undefined;
	#localId = 0;

	readonly #changeSession: Emitter<SessionView>;
	readonly #changeItem: Emitter<TranscriptItem>;
	readonly #reset: Emitter<readonly TranscriptItem[]>;
	readonly #toolExecution: Emitter<ToolExecutionEvent>;
	readonly onDidChangeSession;
	readonly onDidChangeItem;
	readonly onDidReset;
	readonly onToolExecution;

	constructor(onListenerError?: (error: unknown) => void) {
		this.#changeSession = new Emitter<SessionView>(onListenerError);
		this.#changeItem = new Emitter<TranscriptItem>(onListenerError);
		this.#reset = new Emitter<readonly TranscriptItem[]>(onListenerError);
		this.#toolExecution = new Emitter<ToolExecutionEvent>(onListenerError);
		this.onDidChangeSession = this.#changeSession.event;
		this.onDidChangeItem = this.#changeItem.event;
		this.onDidReset = this.#reset.event;
		this.onToolExecution = this.#toolExecution.event;
	}

	get session(): SessionView {
		return this.#session;
	}

	get transcript(): readonly TranscriptItem[] {
		return this.#items;
	}

	/** Name of the most recently started tool that is still running. */
	get runningTool(): string | undefined {
		for (let i = this.#items.length - 1; i >= 0; i--) {
			const item = this.#items[i];
			if (item.kind === "tool" && item.status === "running") return item.name;
		}
		return undefined;
	}

	update(patch: Partial<SessionView>): void {
		this.#session = { ...this.#session, ...patch };
		this.#changeSession.fire(this.#session);
	}

	applyState(state: SessionState): void {
		const patch: Partial<SessionView> = {
			sessionId: state.sessionId,
			sessionFile: state.sessionFile,
			sessionName: state.sessionName,
			model: state.model ? toModelView(state.model) : undefined,
			thinkingLevel: state.thinkingLevel,
			fastModeEnabled: state.fastModeEnabled,
			fastModeActive: state.fastModeActive,
			contextUsage: state.contextUsage,
			todos: (state.todoPhases ?? []).map(phase => ({
				name: phase.name,
				tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
			})),
		};
		if (state.isStreaming !== undefined) patch.isStreaming = state.isStreaming;
		if (state.isCompacting !== undefined) patch.isCompacting = state.isCompacting;
		if (state.queuedMessages) {
			patch.queue = { steering: [...state.queuedMessages.steering], followUp: [...state.queuedMessages.followUp] };
		}
		this.update(patch);
	}

	/** Replace the transcript with a stored conversation. */
	reset(messages: readonly AgentMessage[]): void {
		this.#items = historyToItems(messages);
		this.#index.clear();
		this.#cursors.clear();
		this.#lastAssistantId = undefined;
		this.#items.forEach((item, i) => this.#index.set(item.id, i));
		this.#reset.fire(this.#items);
		this.update({ costUsd: costOf(messages) });
	}

	addNotice(level: NoticeLevel, text: string): void {
		this.#add({ kind: "notice", id: this.#nextLocalId("notice"), level, text });
	}

	addCommandOutput(text: string): void {
		this.#add({ kind: "command_output", id: this.#nextLocalId("output"), text });
	}

	applyEvent(event: SessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.update({ isStreaming: true });
				return;
			case "agent_end":
				this.update({ isStreaming: false });
				return;
			case "message_start":
			case "message_end":
				this.#applyMessage(event.messageId, event.message, event.type === "message_start");
				return;
			case "message_update":
				this.#applyMessageUpdate(event);
				return;
			case "tool_execution_start":
				this.#applyToolStart(event.toolCallId, event.toolName, event.args);
				return;
			case "tool_execution_update": {
				const text = partialText(event.partialResult);
				this.#patchTool(event.toolCallId, {
					...(event.args !== undefined ? { args: event.args } : {}),
					...(text !== undefined ? { partial: text } : {}),
				});
				return;
			}
			case "tool_stream_update": {
				const text = partialText(event.update);
				if (text !== undefined) this.#patchTool(event.toolCallId, { partial: text });
				return;
			}
			case "tool_execution_end":
				this.#applyToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
				return;
			case "queue_update":
				this.update({ queue: { steering: [...event.steering], followUp: [...event.followUp] } });
				return;
			case "thinking_level_changed": {
				const selector = event.configured ?? event.thinkingLevel;
				if (selector === undefined) return;
				this.update({
					thinkingLevel: event.thinkingLevel ?? this.session.thinkingLevel,
					thinkingSelector: selector,
					thinkingResolved: event.configured === "auto" ? event.resolved : undefined,
				});
				return;
			}
			case "notice":
				this.addNotice(event.level, event.message);
				return;
			case "auto_compaction_start":
				this.update({ isCompacting: true });
				return;
			case "auto_compaction_end":
				this.update({ isCompacting: false });
				if (event.errorMessage) this.addNotice("warning", `Compaction failed: ${event.errorMessage}`);
				return;
			case "auto_retry_start":
				this.addNotice(
					"warning",
					`Retrying (attempt ${event.attempt}/${event.maxAttempts}) in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`,
				);
				return;
			case "auto_retry_end":
				if (!event.success) this.addNotice("error", `Retry failed: ${event.finalError ?? "unknown error"}`);
				return;
		}
	}

	#nextLocalId(prefix: string): string {
		this.#localId += 1;
		return `${prefix}-${this.#localId}`;
	}

	#add(item: TranscriptItem): void {
		this.#index.set(item.id, this.#items.length);
		this.#items.push(item);
		this.#changeItem.fire(item);
	}

	#set(item: TranscriptItem): void {
		const at = this.#index.get(item.id);
		if (at === undefined) {
			this.#add(item);
			return;
		}
		this.#items[at] = item;
		this.#changeItem.fire(item);
	}

	#get(id: string): TranscriptItem | undefined {
		const at = this.#index.get(id);
		return at === undefined ? undefined : this.#items[at];
	}

	#applyMessage(messageId: string | undefined, message: AgentMessage, starting: boolean): void {
		if (message.role === "user") {
			const user = message as UserMessage;
			if (!user.synthetic) this.#set(userItem(messageId ?? this.#nextLocalId("user"), user));
			return;
		}
		if (message.role !== "assistant") return;
		const id = messageId ?? (starting ? this.#nextLocalId("assistant") : (this.#lastAssistantId ?? this.#nextLocalId("assistant")));
		const assistant = message as AssistantMessage;
		this.#lastAssistantId = id;
		this.#set(assistantItem(id, assistant, starting));
		if (starting) {
			this.#cursors.set(id, {});
			return;
		}
		this.#cursors.delete(id);
		const cost = assistant.usage?.cost?.total;
		if (typeof cost === "number") this.update({ costUsd: (this.#session.costUsd ?? 0) + cost });
	}

	#applyMessageUpdate(event: Extract<SessionEvent, { type: "message_update" }>): void {
		if (event.message?.role !== "assistant") return;
		const id = event.messageId ?? this.#lastAssistantId ?? this.#nextLocalId("assistant");
		this.#lastAssistantId = id;
		const message = event.message as AssistantMessage;
		if (Array.isArray(message.content)) {
			this.#set(assistantItem(id, message, true));
			return;
		}
		const update = event.assistantMessageEvent;
		if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
		const delta = "delta" in update && typeof update.delta === "string" ? update.delta : "";
		const contentIndex = "contentIndex" in update && typeof update.contentIndex === "number" ? update.contentIndex : 0;
		const existing = this.#get(id);
		const item: AssistantItem =
			existing?.kind === "assistant"
				? { ...existing }
				: { kind: "assistant", id, text: "", thinking: "", streaming: true };
		let cursor = this.#cursors.get(id);
		if (!cursor) {
			cursor = {};
			this.#cursors.set(id, cursor);
		}
		if (update.type === "text_delta") {
			if (cursor.textIndex !== undefined && cursor.textIndex !== contentIndex && item.text) item.text += "\n\n";
			cursor.textIndex = contentIndex;
			item.text += delta;
		} else {
			if (cursor.thinkingIndex !== undefined && cursor.thinkingIndex !== contentIndex && item.thinking)
				item.thinking += "\n\n";
			cursor.thinkingIndex = contentIndex;
			item.thinking += delta;
		}
		this.#set(item);
	}

	#applyToolStart(toolCallId: string, name: string, args: unknown): void {
		this.#set({ kind: "tool", id: toolCallId, name, args, status: "running", startedAt: Date.now() });
		this.#toolExecution.fire({ phase: "start", toolCallId, name, args });
	}

	#patchTool(toolCallId: string, patch: Partial<ToolItem>): void {
		const existing = this.#get(toolCallId);
		if (existing?.kind !== "tool") return;
		this.#set({ ...existing, ...patch });
	}

	#applyToolEnd(toolCallId: string, name: string, rawResult: unknown, isError: boolean | undefined): void {
		const result = toolResultView(rawResult, isError);
		const existing = this.#get(toolCallId);
		const base: ToolItem =
			existing?.kind === "tool"
				? existing
				: { kind: "tool", id: toolCallId, name, args: undefined, status: "running", startedAt: Date.now() };
		const item: ToolItem = { ...base, status: result.isError ? "error" : "done", result, endedAt: Date.now() };
		delete item.partial;
		this.#set(item);
		this.#toolExecution.fire({ phase: "end", toolCallId, name, args: item.args, result });
	}
}
