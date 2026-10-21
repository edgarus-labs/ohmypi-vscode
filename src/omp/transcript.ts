import { isRecord } from "../shared/guards";
import { emptySessionView } from "../shared/session";
import type { SessionPhase, SessionView, ToolExecutionEvent, ToolResultView, TranscriptItem, TurnProgressView, TurnStatus, UsageView } from "./api";
import { Emitter } from "./emitter";
import { toModelView } from "./models";
import type {
	AgentMessage,
	AssistantMessage,
	BashExecutionMessage,
	CompactionSummaryMessage,
	MessageContent,
	SessionEvent,
	SessionState,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "./protocol";
import { StoredTurns, type TurnSummaryItem, TurnTally } from "./turns";

type UserItem = Extract<TranscriptItem, { kind: "user" }>;
type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type NoticeLevel = "info" | "warning" | "error";

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

function userItem(id: string, message: UserMessage): UserItem {
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

/** Text carried by a `tool_execution_update.partialResult`, if any. */
function partialText(payload: unknown): string | undefined {
	if (typeof payload === "string") return payload;
	if (isRecord(payload) && Array.isArray(payload.content)) return textOf(payload.content);
	return undefined;
}

/**
 * Map a stored conversation (`get_messages`, `get_subagent_messages`) into
 * transcript items. Tool calls become tool items completed by their results;
 * each finished turn is followed by its summary. `running`: the agent is still
 * at work, so the calls of its last reply that have no result yet are running.
 */
export function historyToItems(messages: readonly AgentMessage[], options: { running?: boolean } = {}): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const tools = new Map<string, number>();
	const turns = new StoredTurns();
	let lastCalls: number[] = [];
	messages.forEach((message, index) => {
		const id = `h${index}`;
		switch (message.role) {
			case "user": {
				const user = message as UserMessage;
				if (user.synthetic) return;
				turns.user(user.timestamp);
				items.push(userItem(id, user));
				return;
			}
			case "assistant": {
				const assistant = message as AssistantMessage;
				items.push(assistantItem(id, assistant, false));
				lastCalls = [];
				for (const block of assistant.content ?? []) {
					if (block.type !== "toolCall") continue;
					const call = block as ToolCall;
					tools.set(call.id, items.length);
					lastCalls.push(items.length);
					items.push({
						kind: "tool",
						id: call.id,
						name: call.name,
						args: call.arguments,
						status: "unresolved",
						startedAt: assistant.timestamp ?? 0,
					});
				}
				turns.assistant(assistant, id, items.length);
				return;
			}
			case "toolResult": {
				const result = message as ToolResultMessage;
				turns.toolResult(result.timestamp);
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
			case "compactionSummary": {
				const compaction = message as CompactionSummaryMessage;
				items.push({
					kind: "notice",
					id,
					level: "info",
					text: `Earlier messages were compacted into a summary: ${compaction.shortSummary || compaction.summary}`,
				});
				return;
			}
		}
	});
	if (options.running) {
		for (const at of lastCalls) {
			const call = items[at] as ToolItem;
			if (call.status === "unresolved") items[at] = { ...call, status: "running" };
		}
	}
	return turns.withSummaries(items);
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

/** The turn in progress in a live session. */
interface LiveTurn {
	tally: TurnTally;
	progress: TurnProgressView;
	/** The agent started or replied; a prompt it never worked on (a local command) gets no summary. */
	agentRan: boolean;
	aborting: boolean;
	/** What OMP reported in the prompt result, or `error` when the process went away. */
	outcome?: TurnStatus;
}

/**
 * Reduces OMP session events and snapshots into the host's {@link SessionView}
 * and transcript. A turn starts when the session leaves `idle` (the prompt is
 * submitted or the agent wakes up) and ends when it is `idle` or `yielded`
 * again; a turn the agent worked on is followed by its summary.
 */
export class SessionStore {
	#session: SessionView = emptySessionView();
	#items: TranscriptItem[] = [];
	readonly #index = new Map<string, number>();
	readonly #cursors = new Map<string, StreamCursor>();
	#lastAssistantId: string | undefined;
	#lastUserId: string | undefined;
	#localId = 0;
	/** Pending user items not matched to an OMP user message yet, oldest first. */
	readonly #pendingUsers: string[] = [];
	/** OMP user `messageId` → id of the pending item its message replaced. */
	readonly #userAliases = new Map<string, string>();
	readonly #now: () => number;
	#turn: LiveTurn | undefined;

	readonly #changeSession: Emitter<SessionView>;
	readonly #changeItem: Emitter<TranscriptItem>;
	readonly #reset: Emitter<readonly TranscriptItem[]>;
	readonly #toolExecution: Emitter<ToolExecutionEvent>;
	readonly onDidChangeSession;
	readonly onDidChangeItem;
	readonly onDidReset;
	readonly onToolExecution;

	constructor(onListenerError?: (error: unknown) => void, now: () => number = Date.now) {
		this.#now = now;
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
		const summary = patch.phase === undefined || patch.phase === this.#session.phase ? undefined : this.#trackTurn(patch.phase);
		const next = { ...this.#session, ...patch };
		if (this.#turn) next.turn = this.#turn.progress;
		else delete next.turn;
		this.#session = next;
		this.#changeSession.fire(next);
		if (summary) this.#add(summary);
	}

	/** How OMP says the current turn ended; consulted when the turn ends. */
	noteTurnOutcome(status: TurnStatus): void {
		if (this.#turn) this.#turn.outcome = status;
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
		if (state.isCompacting !== undefined) patch.isCompacting = state.isCompacting;
		if (state.queuedMessages) {
			patch.queue = { steering: [...state.queuedMessages.steering], followUp: [...state.queuedMessages.followUp] };
		}
		this.update(patch);
	}

	/** Replace the transcript with a stored conversation; pending user items stay at its end. */
	reset(messages: readonly AgentMessage[]): void {
		const pending = this.#pendingUsers.flatMap(id => this.#get(id) ?? []);
		this.#items = [...historyToItems(messages), ...pending];
		this.#cursors.clear();
		this.#userAliases.clear();
		this.#lastAssistantId = undefined;
		this.#lastUserId = undefined;
		this.#reindex();
		this.#reset.fire(this.#items);
		this.update({ costUsd: costOf(messages) });
	}

	/** Adds a user prompt OMP has not recorded yet, marked pending; returns its id. */
	addPendingUser(text: string, imageCount: number): string {
		const id = this.#nextLocalId("user");
		this.#pendingUsers.push(id);
		this.#add({ kind: "user", id, text, ...(imageCount > 0 ? { imageCount } : {}), pending: true });
		return id;
	}

	/** The prompt of a pending item completed without OMP recording it: the item stays, no longer pending. */
	confirmPendingUser(id: string): void {
		if (!this.#takePending(id)) return;
		const item = this.#get(id);
		if (item?.kind !== "user") return;
		const confirmed = { ...item };
		delete confirmed.pending;
		this.#set(confirmed);
	}

	/** Removes a pending item whose prompt OMP did not admit; the transcript is reset without it. */
	removePendingUser(id: string): void {
		if (!this.#takePending(id)) return;
		this.#items = this.#items.filter(item => item.id !== id);
		this.#reindex();
		this.#reset.fire(this.#items);
	}

	addNotice(level: NoticeLevel, text: string): void {
		this.#add({ kind: "notice", id: this.#nextLocalId("notice"), level, text });
	}

	addCommandOutput(text: string): void {
		this.#add({ kind: "command_output", id: this.#nextLocalId("output"), text });
	}

	/** The process went away: streaming replies stop streaming and running tools fail with `Interrupted: <reason>`. */
	interrupt(reason: string): void {
		this.#cursors.clear();
		const endedAt = Date.now();
		for (const item of this.#items) {
			if (item.kind === "assistant" && item.streaming) this.#set({ ...item, streaming: false });
			else if (item.kind === "tool" && item.status === "running") {
				this.#set({ ...item, status: "error", result: { text: `Interrupted: ${reason}`, isError: true }, endedAt });
			}
		}
	}

	dispose(): void {
		this.#changeSession.dispose();
		this.#changeItem.dispose();
		this.#reset.dispose();
		this.#toolExecution.dispose();
	}

	applyEvent(event: SessionEvent): void {
		switch (event.type) {
			case "agent_start": {
				const started = this.#turn === undefined;
				this.#startTurn().agentRan = true;
				if (started) this.update({});
				return;
			}
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

	#reindex(): void {
		this.#index.clear();
		this.#items.forEach((item, i) => this.#index.set(item.id, i));
	}

	#takePending(id: string): boolean {
		const at = this.#pendingUsers.indexOf(id);
		if (at < 0) return false;
		this.#pendingUsers.splice(at, 1);
		return true;
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
			if (user.synthetic) return;
			const id = this.#userItemId(messageId, starting);
			this.#lastUserId = id;
			this.#set(this.#recordedUser(id, user));
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
		const patch: Partial<SessionView> = {};
		const cost = assistant.usage?.cost?.total;
		if (typeof cost === "number") patch.costUsd = (this.#session.costUsd ?? 0) + cost;
		const turn = this.#turn;
		if (turn) {
			turn.agentRan = true;
			turn.tally.add(assistant);
			turn.progress = { ...turn.progress, outputTokens: turn.tally.usage.output };
		}
		if (turn || patch.costUsd !== undefined) this.update(patch);
	}

	#startTurn(): LiveTurn {
		this.#turn ??= { tally: new TurnTally(), progress: { startedAt: this.#now(), outputTokens: 0 }, agentRan: false, aborting: false };
		return this.#turn;
	}

	/** Starts a turn when the session becomes busy, ends it when it is idle or yielded; returns the summary to append. */
	#trackTurn(phase: SessionPhase): TurnSummaryItem | undefined {
		if (phase !== "idle" && phase !== "yielded") {
			const turn = this.#startTurn();
			if (phase === "aborting") turn.aborting = true;
			return undefined;
		}
		const turn = this.#turn;
		this.#turn = undefined;
		if (!turn?.agentRan) return undefined;
		const status = turn.outcome ?? turn.tally.impliedStatus(turn.aborting);
		return turn.tally.summary(this.#nextLocalId("turn"), status, this.#now() - turn.progress.startedAt);
	}

	/** Item id of an OMP user message: the item it already updates, else the oldest pending item, else a new one. */
	#userItemId(messageId: string | undefined, starting: boolean): string {
		if (messageId === undefined) {
			if (!starting && this.#lastUserId !== undefined) return this.#lastUserId;
			return this.#pendingUsers.shift() ?? this.#nextLocalId("user");
		}
		const known = this.#userAliases.get(messageId) ?? (this.#index.has(messageId) ? messageId : undefined);
		if (known !== undefined) return known;
		const pending = this.#pendingUsers.shift();
		if (pending === undefined) return messageId;
		this.#userAliases.set(messageId, pending);
		return pending;
	}

	/** OMP's user message; a typed slash command it expanded stays visible with the expansion alongside. */
	#recordedUser(id: string, message: UserMessage): UserItem {
		const item = userItem(id, message);
		const shown = this.#get(id);
		const typed = shown?.kind === "user" && (shown.pending || shown.expandedText !== undefined) ? shown.text : undefined;
		if (typed === undefined || !typed.startsWith("/") || typed === item.text) return item;
		return { ...item, text: typed, expandedText: item.text };
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

	/** A live update of a call; a reloaded call without a result is running after all. */
	#patchTool(toolCallId: string, patch: Partial<ToolItem>): void {
		const existing = this.#get(toolCallId);
		if (existing?.kind !== "tool") return;
		this.#set({ ...existing, ...patch, ...(existing.status === "unresolved" ? { status: "running" } : {}) });
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
