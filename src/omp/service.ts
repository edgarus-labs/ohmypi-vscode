import * as fs from "node:fs";
import * as path from "node:path";
import { AgentRegistry } from "./agents";
import type {
	AgentView,
	ConnectionStatus,
	Event,
	InteractionRequest,
	InteractionResponse,
	Logger,
	ModelView,
	OmpServiceApi,
	OmpServiceOptions,
	PresentationRequest,
	PromptImage,
	PromptMode,
	PromptOutcome,
	SessionSummary,
	SessionView,
	ToolExecutionEvent,
	TranscriptItem,
} from "./api";
import { OmpRequestError, OmpRpcClient, type RequestArgs, type TransportClose } from "./client";
import { Emitter } from "./emitter";
import { toModelView } from "./models";
import { PromptTracker } from "./phase";
import { OmpProcess } from "./process";
import type {
	AgentMessage,
	CommandMap,
	CommandType,
	ExtensionUiRequest,
	ExtensionUiResponse,
	SessionEvent,
} from "./protocol";
import { listSessions } from "./sessions";
import { historyToItems, SessionStore } from "./transcript";

/** Restart/shutdown timing; production uses the defaults. */
export interface OmpServiceTuning {
	/** Delay before each automatic restart; its length is the restart budget per window. */
	restartDelaysMs?: number[];
	restartWindowMs?: number;
	shutdownGraceMs?: number;
	readyTimeoutMs?: number;
}

interface PendingInteraction {
	secret: boolean;
}

interface SessionBinding {
	resumeSessionFile?: string;
	newSession?: boolean;
}

const DEFAULT_RESTART_DELAYS_MS = [500, 2000, 5000];
const SESSION_COMMAND_TIMEOUT_MS = 60_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 120_000;
const HISTORY_PAGE_LIMIT = 256;
/** OMP's per-turn effort selector (`ConfiguredThinkingLevel` "auto"). */
const AUTO_THINKING = "auto";

function describeClose(close: TransportClose): string {
	if (close.error) return `OMP failed to run: ${close.error.message}`;
	return close.signal ? `OMP process exited (signal ${close.signal})` : `OMP process exited (code ${close.code})`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** OMP's wire `input` has no secret flag; a request is secret only when it carries one of these truthy fields. */
const SECRET_FLAGS: Record<string, true> = { secret: true, password: true, masked: true };

export class OmpService implements OmpServiceApi {
	readonly #options: OmpServiceOptions;
	readonly #logger: Logger;
	readonly #restartDelaysMs: number[];
	readonly #restartWindowMs: number;
	readonly #graceMs: number;
	readonly #readyTimeoutMs: number;

	readonly #store: SessionStore;
	readonly #agentRegistry: AgentRegistry;
	readonly #tracker: PromptTracker;
	readonly #pendingInteractions = new Map<string, PendingInteraction>();

	#connection: ConnectionStatus = { state: "stopped" };
	#process: OmpProcess | undefined;
	#client: OmpRpcClient | undefined;
	#generation = 0;
	#launching = false;
	#stopping = false;
	#restartTimes: number[] = [];
	#restartTimer: NodeJS.Timeout | undefined;

	readonly #connectionChange: Emitter<ConnectionStatus>;
	readonly #interactionRequest: Emitter<InteractionRequest>;
	readonly #interactionCancelled: Emitter<string>;
	readonly #presentation: Emitter<PresentationRequest>;

	readonly onDidChangeConnection: Event<ConnectionStatus>;
	readonly onDidChangeSession: Event<SessionView>;
	readonly onDidChangeTranscriptItem: Event<TranscriptItem>;
	readonly onDidResetTranscript: Event<readonly TranscriptItem[]>;
	readonly onDidChangeAgents: Event<readonly AgentView[]>;
	readonly onToolExecution: Event<ToolExecutionEvent>;
	readonly onInteractionRequest: Event<InteractionRequest>;
	readonly onInteractionCancelled: Event<string>;
	readonly onPresentation: Event<PresentationRequest>;

	constructor(options: OmpServiceOptions, tuning: OmpServiceTuning = {}) {
		this.#options = options;
		this.#logger = options.logger;
		this.#restartDelaysMs = tuning.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
		this.#restartWindowMs = tuning.restartWindowMs ?? 60_000;
		this.#graceMs = tuning.shutdownGraceMs ?? 3000;
		this.#readyTimeoutMs = tuning.readyTimeoutMs ?? 30_000;

		const onListenerError = (error: unknown) => this.#logger.error("OMP listener failed", error);
		this.#store = new SessionStore(onListenerError);
		this.#agentRegistry = new AgentRegistry(onListenerError);
		this.#tracker = new PromptTracker(phase => this.#store.update({ phase }));
		this.#connectionChange = new Emitter(onListenerError);
		this.#interactionRequest = new Emitter(onListenerError);
		this.#interactionCancelled = new Emitter(onListenerError);
		this.#presentation = new Emitter(onListenerError);

		this.onDidChangeConnection = this.#connectionChange.event;
		this.onDidChangeSession = this.#store.onDidChangeSession;
		this.onDidChangeTranscriptItem = this.#store.onDidChangeItem;
		this.onDidResetTranscript = this.#store.onDidReset;
		this.onDidChangeAgents = this.#agentRegistry.onDidChange;
		this.onToolExecution = this.#store.onToolExecution;
		this.onInteractionRequest = this.#interactionRequest.event;
		this.onInteractionCancelled = this.#interactionCancelled.event;
		this.onPresentation = this.#presentation.event;

		this.#store.onDidChangeSession(() => this.#updateMainAgent());
		this.#store.onToolExecution(() => this.#updateMainAgent());
	}

	get cwd(): string {
		return this.#options.cwd;
	}

	get connection(): ConnectionStatus {
		return this.#connection;
	}

	get session(): SessionView {
		return this.#store.session;
	}

	get transcript(): readonly TranscriptItem[] {
		return this.#store.transcript;
	}

	get agents(): readonly AgentView[] {
		return this.#agentRegistry.agents;
	}

	async start(options: SessionBinding = {}): Promise<void> {
		if (this.#client || this.#launching) throw new Error("OMP is already running");
		this.#stopping = false;
		this.#restartTimes = [];
		try {
			await this.#launch(options, "starting");
		} catch (error) {
			if (!this.#stopping) {
				this.#setConnection({ state: "failed", detail: errorMessage(error), executable: this.#options.executable });
			}
			throw error;
		}
	}

	async restart(): Promise<void> {
		const sessionFile = this.#store.session.sessionFile;
		await this.stop();
		await this.start({ resumeSessionFile: sessionFile });
	}

	async stop(): Promise<void> {
		this.#stopping = true;
		clearTimeout(this.#restartTimer);
		this.#restartTimer = undefined;
		const proc = this.#process;
		const client = this.#client;
		if (proc) {
			try {
				await proc.shutdown(this.#graceMs);
			} finally {
				client?.dispose();
				this.#process = undefined;
				this.#client = undefined;
			}
		}
		this.#setConnection({ state: "stopped", detail: this.#connection.detail, executable: this.#options.executable });
	}

	dispose(): void {
		this.stop().catch(error => this.#logger.error("Failed to stop OMP", error));
		this.#connectionChange.dispose();
		this.#interactionRequest.dispose();
		this.#interactionCancelled.dispose();
		this.#presentation.dispose();
	}

	async listModels(): Promise<ModelView[]> {
		const { models } = await this.#request("get_available_models", undefined, { timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS });
		return models.map(toModelView);
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const model = await this.#request("set_model", { provider, modelId }, { timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS });
		this.#store.update({ model: toModelView(model) });
		await this.#refreshThinkingLevels();
	}

	async setThinkingLevel(level: string): Promise<void> {
		await this.#request("set_thinking_level", { level });
		this.#store.update({
			thinkingSelector: level,
			thinkingResolved: undefined,
			...(level === AUTO_THINKING ? {} : { thinkingLevel: level }),
		});
	}

	async setFastMode(enabled: boolean): Promise<void> {
		const result = await this.#request("set_fast_mode", { enabled });
		this.#store.update({ fastModeEnabled: result.enabled, fastModeActive: result.active });
	}

	prompt(text: string, mode: PromptMode = "auto", images: readonly PromptImage[] = []): Promise<PromptOutcome> {
		const client = this.#client;
		if (!client || this.#connection.state !== "ready") {
			return Promise.reject(new Error(`OMP is not running (${this.#connection.state})`));
		}
		const busy = this.#tracker.phase !== "idle";
		const streamingBehavior = busy ? (mode === "followUp" ? "followUp" : "steer") : undefined;
		const id = client.nextId();
		this.#store.update({ lastError: undefined });
		const outcome = this.#tracker.submit(id);
		const params: CommandMap["prompt"]["params"] = {
			message: text,
			...(images.length > 0 ? { images: images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })) } : {}),
			...(streamingBehavior ? { streamingBehavior } : {}),
		};
		client.request("prompt", params, { id, timeoutMs: 0 }).then(
			ack => this.#tracker.acknowledged(id, ack?.agentInvoked),
			error => this.#tracker.rejected(id, errorMessage(error)),
		);
		return outcome.then(result => {
			if (result.status === "error" && result.error) this.#store.update({ lastError: result.error });
			return result;
		});
	}

	async abort(): Promise<void> {
		this.#tracker.abortRequested();
		await this.#request("abort");
	}

	async newSession(): Promise<void> {
		const { cancelled } = await this.#request("new_session", {}, { timeoutMs: SESSION_COMMAND_TIMEOUT_MS });
		if (cancelled) throw new Error("Creating a new session was cancelled by an OMP extension");
		await this.#loadSession(this.#requireClient());
	}

	async switchSession(sessionFile: string): Promise<void> {
		const { cancelled } = await this.#request(
			"switch_session",
			{ sessionPath: sessionFile },
			{ timeoutMs: SESSION_COMMAND_TIMEOUT_MS },
		);
		if (cancelled) throw new Error("Switching sessions was cancelled by an OMP extension");
		await this.#loadSession(this.#requireClient());
	}

	async setSessionName(name: string): Promise<void> {
		await this.#request("set_session_name", { name });
		this.#store.update({ sessionName: name });
	}

	async listSessions(): Promise<SessionSummary[]> {
		const sessionFile = this.#store.session.sessionFile;
		return sessionFile ? listSessions(path.dirname(sessionFile)) : [];
	}

	respondInteraction(id: string, response: InteractionResponse): void {
		const pending = this.#pendingInteractions.get(id);
		if (!pending) {
			this.#logger.debug(`Response to an unknown or withdrawn OMP interaction ${id} ignored`);
			return;
		}
		this.#pendingInteractions.delete(id);
		const client = this.#client;
		if (!client) {
			this.#logger.warn(`Cannot answer OMP interaction ${id}: OMP is not running`);
			return;
		}
		let frame: ExtensionUiResponse;
		switch (response.kind) {
			case "value":
				frame = { type: "extension_ui_response", id, value: response.value };
				break;
			case "confirmed":
				frame = { type: "extension_ui_response", id, confirmed: response.confirmed };
				break;
			case "cancelled":
				frame = { type: "extension_ui_response", id, cancelled: true };
				break;
			case "answers":
				frame = { type: "extension_ui_response", id, answers: response.answers };
				break;
		}
		try {
			client.sendUiResponse(frame, pending.secret);
		} catch (error) {
			this.#logger.error(`Failed to answer OMP interaction ${id}`, error);
		}
	}

	async cancelAgent(agentId: string): Promise<boolean> {
		if (agentId === "main") {
			await this.abort();
			return true;
		}
		const { cancelled } = await this.#request("cancel_subagent", { subagentId: agentId });
		return cancelled;
	}

	async steerAgent(agentId: string, message: string): Promise<void> {
		if (agentId === "main") {
			this.prompt(message, "steer").catch(error => this.#logger.error("Steering the main agent failed", error));
			return;
		}
		await this.#request("steer_subagent", { subagentId: agentId, message });
	}

	async getAgentTranscript(agentId: string): Promise<TranscriptItem[]> {
		if (agentId === "main") return [...this.#store.transcript];
		const { messages } = await this.#request("get_subagent_messages", { subagentId: agentId });
		return historyToItems(messages);
	}

	// -------------------------------------------------------------------------

	#setConnection(status: ConnectionStatus): void {
		this.#connection = status;
		this.#connectionChange.fire(status);
	}

	#requireClient(): OmpRpcClient {
		const client = this.#client;
		if (!client || this.#connection.state !== "ready") {
			throw new Error(`OMP is not running (${this.#connection.state})`);
		}
		return client;
	}

	#request<K extends CommandType>(type: K, ...args: RequestArgs<K>): Promise<CommandMap[K]["result"]> {
		const client = this.#client;
		if (!client || this.#connection.state !== "ready") {
			return Promise.reject(new Error(`OMP is not running (${this.#connection.state})`));
		}
		return client.request(type, ...args);
	}

	async #launch(binding: SessionBinding, state: "starting" | "restarting", detail?: string): Promise<void> {
		const generation = ++this.#generation;
		const { executable, extraArgs, cwd, env } = this.#options;
		this.#setConnection({ state, detail, executable });
		this.#launching = true;
		const proc = new OmpProcess({ executable, args: extraArgs, cwd, env, logger: this.#logger });
		const client = new OmpRpcClient(proc, {
			logger: this.#logger,
			trace: this.#options.traceRpc === true,
			readyTimeoutMs: this.#readyTimeoutMs,
			requestTimeoutMs: this.#options.requestTimeoutMs,
		});
		this.#process = proc;
		this.#client = client;
		this.#wire(client, generation);
		try {
			await client.start();
			await client.request("set_subagent_subscription", { level: "progress" });
			await this.#configureOptional(client);
			await this.#bindSession(client, binding);
			await this.#loadSession(client);
		} catch (error) {
			this.#generation++;
			this.#process = undefined;
			this.#client = undefined;
			this.#tracker.terminate(errorMessage(error));
			client.dispose();
			await proc.shutdown(this.#graceMs).catch(shutdownError =>
				this.#logger.error("Failed to shut down OMP after a failed start", shutdownError),
			);
			throw error;
		} finally {
			this.#launching = false;
		}
		this.#setConnection({
			state: "ready",
			pid: proc.pid,
			executable,
			protocolVersion: client.protocolVersion,
		});
		this.#logger.info(`OMP ready (pid ${proc.pid}, protocol v${client.protocolVersion})`);
	}

	async #configureOptional(client: OmpRpcClient): Promise<void> {
		try {
			await client.request("set_ask_dialog", { enabled: true });
		} catch (error) {
			this.#logger.info(`OMP ask dialog unavailable; using select prompts: ${errorMessage(error)}`);
		}
		try {
			const filter = await client.request("set_event_filter", { events: null, messageUpdates: "delta" });
			if (filter?.messageUpdates !== "delta") this.#logger.debug("OMP does not project message updates; using full snapshots");
		} catch (error) {
			this.#logger.warn(`OMP event filter could not be set: ${errorMessage(error)}`);
		}
	}

	async #bindSession(client: OmpRpcClient, binding: SessionBinding): Promise<void> {
		const timeoutMs = SESSION_COMMAND_TIMEOUT_MS;
		if (binding.resumeSessionFile) {
			if (fs.existsSync(binding.resumeSessionFile)) {
				const { cancelled } = await client.request(
					"switch_session",
					{ sessionPath: binding.resumeSessionFile },
					{ timeoutMs },
				);
				if (cancelled) this.#logger.warn(`Resuming ${binding.resumeSessionFile} was cancelled by an OMP extension`);
				return;
			}
			this.#logger.warn(`Session file ${binding.resumeSessionFile} no longer exists; starting a new session`);
			await client.request("new_session", {}, { timeoutMs });
			return;
		}
		if (binding.newSession) await client.request("new_session", {}, { timeoutMs });
	}

	/** Snapshot state, thinking levels, history and subagents after (re)binding a session. */
	async #loadSession(client: OmpRpcClient): Promise<void> {
		const state = await client.request("get_state");
		this.#store.applyState(state);
		const { levels } = await client.request("get_available_thinking_levels");
		this.#store.update({ availableThinkingLevels: this.#selectableLevels(levels), thinkingSelector: await this.#journaledThinkingSelector(client) });
		this.#store.reset(await this.#loadMessages(client));
		this.#agentRegistry.clearSubagents();
		const { subagents } = await client.request("get_subagents");
		this.#agentRegistry.applySnapshot(subagents);
	}

	async #loadMessages(client: OmpRpcClient): Promise<AgentMessage[]> {
		const timeoutMs = SESSION_COMMAND_TIMEOUT_MS;
		if (client.protocolVersion === 2) {
			try {
				const messages: AgentMessage[] = [];
				let cursor: string | undefined;
				let total: number | undefined;
				do {
					const page = await client.request(
						"get_messages_page",
						{ limit: HISTORY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
						{ timeoutMs },
					);
					if (total !== undefined && page.totalMessages !== total) {
						throw new OmpRequestError("Message pages changed while loading", "get_messages_page", "stale_cursor");
					}
					total = page.totalMessages;
					messages.push(...page.messages);
					cursor = page.nextCursor;
				} while (cursor);
				return messages;
			} catch (error) {
				if (!(error instanceof OmpRequestError) || error.code === "closed" || error.code === "timeout") throw error;
				this.#logger.debug(`Paged history unavailable (${error.message}); loading it in one request`);
			}
		}
		const { messages } = await client.request("get_messages", undefined, { timeoutMs });
		return messages;
	}

	async #refreshThinkingLevels(): Promise<void> {
		const { levels } = await this.#request("get_available_thinking_levels");
		this.#store.update({ availableThinkingLevels: this.#selectableLevels(levels) });
	}

	/**
	 * OMP's discovery omits its `auto` selector; OMP offers it (after `off`) for every
	 * reasoning model, as in `getAvailableEffortSelectors`.
	 */
	#selectableLevels(levels: string[]): string[] {
		if (!this.#store.session.model?.reasoning || levels.length === 0 || levels.includes(AUTO_THINKING)) return levels;
		const afterOff = levels.indexOf("off") + 1;
		return [...levels.slice(0, afterOff), AUTO_THINKING, ...levels.slice(afterOff)];
	}

	/**
	 * `get_state` reports only the effective level, so `auto` is recovered from the newest
	 * journaled `thinking_level_change` entry (`configured`, else its level).
	 */
	async #journaledThinkingSelector(client: OmpRpcClient): Promise<string | undefined> {
		const state = this.#store.session;
		try {
			const { entries } = await client.request("get_entries", undefined, { timeoutMs: SESSION_COMMAND_TIMEOUT_MS });
			const latest = entries.findLast(entry => entry.type === "thinking_level_change");
			return latest?.configured ?? latest?.thinkingLevel ?? state.thinkingLevel;
		} catch (error) {
			this.#logger.warn(`Reading the effort selector from the session journal failed; showing the effective level: ${errorMessage(error)}`);
			return state.thinkingLevel;
		}
	}

	/** Background refresh after events that change state without carrying it. */
	#refreshState(withThinkingLevels = false): void {
		const refresh = async () => {
			this.#store.applyState(await this.#request("get_state"));
			if (withThinkingLevels) await this.#refreshThinkingLevels();
		};
		refresh().catch(error => {
			if (error instanceof OmpRequestError && error.code === "closed") return;
			this.#logger.warn(`Refreshing OMP state failed: ${errorMessage(error)}`);
		});
	}

	#updateMainAgent(): void {
		const { phase, model } = this.#store.session;
		this.#agentRegistry.setMain({
			phase,
			model: model ? `${model.provider}/${model.id}` : undefined,
			activity: this.#store.runningTool,
		});
	}

	#wire(client: OmpRpcClient, generation: number): void {
		const current = () => generation === this.#generation;
		client.onSessionEvent(event => current() && this.#onSessionEvent(event));
		client.onPromptResult(frame => {
			if (!current()) return;
			this.#tracker.promptResult(frame);
			if (frame.status === "error" && frame.error) this.#store.update({ lastError: frame.error.message });
		});
		client.onSessionSettled(() => current() && this.#tracker.sessionSettled());
		client.onUiRequest(request => current() && this.#onUiRequest(request));
		client.onSubagentFrame(frame => current() && this.#agentRegistry.applyFrame(frame));
		client.onCommandOutput(frame => current() && this.#store.addCommandOutput(frame.text));
		client.onSessionInfoUpdate(frame => {
			if (current() && frame.title !== undefined) this.#store.update({ sessionName: frame.title });
		});
		client.onConfigUpdate(() => current() && this.#refreshState(true));
		client.onClose(close => {
			if (current()) this.#onClose(close);
		});
	}

	#onSessionEvent(event: SessionEvent): void {
		this.#store.applyEvent(event);
		switch (event.type) {
			case "agent_start":
				this.#tracker.agentStart();
				return;
			case "agent_end":
				this.#tracker.agentEnd(event.yielded ?? event.isTerminal !== false);
				this.#refreshState();
				return;
			case "model_changed":
				this.#refreshState(true);
				return;
		}
	}

	#onUiRequest(request: ExtensionUiRequest): void {
		const method: string = request.method;
		const timeout = "timeout" in request && typeof request.timeout === "number" ? { timeoutMs: request.timeout } : {};
		switch (request.method) {
			case "confirm":
				this.#interact({ id: request.id, kind: "confirm", title: request.title, message: request.message, ...timeout }, false);
				return;
			case "select":
				this.#interact(
					{
						id: request.id,
						kind: "select",
						title: request.title,
						options: request.options.map((label, i) => {
							const description = request.optionDetails?.[i]?.description;
							return description ? { label, description } : { label };
						}),
						...timeout,
					},
					false,
				);
				return;
			case "input": {
				const secret = Object.entries(request).some(([key, value]) => SECRET_FLAGS[key] === true && Boolean(value));
				this.#interact(
					{
						id: request.id,
						kind: "input",
						title: request.title,
						...(request.placeholder !== undefined ? { placeholder: request.placeholder } : {}),
						secret,
						...timeout,
					},
					secret,
				);
				return;
			}
			case "editor":
				this.#interact(
					{
						id: request.id,
						kind: "editor",
						title: request.title,
						...(request.prefill !== undefined ? { prefill: request.prefill } : {}),
					},
					false,
				);
				return;
			case "ask":
				this.#interact({ id: request.id, kind: "ask", questions: request.questions, ...timeout }, false);
				return;
			case "cancel":
				if (this.#pendingInteractions.delete(request.targetId)) this.#interactionCancelled.fire(request.targetId);
				return;
			case "notify":
				this.#presentation.fire({ kind: "notify", message: request.message, level: request.notifyType ?? "info" });
				return;
			case "setStatus":
				this.#presentation.fire({
					kind: "status",
					key: request.statusKey,
					...(request.statusText !== undefined ? { text: request.statusText } : {}),
				});
				return;
			case "open_url":
				this.#presentation.fire({
					kind: "openUrl",
					url: request.launchUrl ?? request.url,
					...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
				});
				return;
			case "set_editor_text":
				this.#presentation.fire({ kind: "editorText", text: request.text });
				return;
			case "setWidget":
			case "setTitle":
				this.#logger.debug(`OMP ${request.method} request ignored`);
				return;
			default:
				this.#logger.debug(`Unsupported OMP UI method ${method} ignored`);
		}
	}

	#interact(request: InteractionRequest, secret: boolean): void {
		this.#pendingInteractions.set(request.id, { secret });
		this.#interactionRequest.fire(request);
	}

	#onClose(close: TransportClose): void {
		const detail = describeClose(close);
		this.#process = undefined;
		this.#client = undefined;
		this.#tracker.terminate(detail);
		this.#store.update({ isStreaming: false, isCompacting: false });
		for (const id of this.#pendingInteractions.keys()) this.#interactionCancelled.fire(id);
		this.#pendingInteractions.clear();
		if (this.#launching || this.#stopping) return;

		this.#logger.warn(`${detail} unexpectedly`);
		if (!this.#options.autoRestart) {
			this.#setConnection({ state: "failed", detail, executable: this.#options.executable });
			return;
		}
		this.#scheduleRestart(detail);
	}

	#scheduleRestart(detail: string): void {
		const now = Date.now();
		this.#restartTimes = this.#restartTimes.filter(time => now - time < this.#restartWindowMs);
		const attempt = this.#restartTimes.length;
		if (attempt >= this.#restartDelaysMs.length) {
			this.#setConnection({
				state: "failed",
				detail: `${detail}; gave up after ${attempt} restarts within ${Math.round(this.#restartWindowMs / 1000)}s`,
				executable: this.#options.executable,
			});
			return;
		}
		this.#restartTimes.push(now);
		const delay = this.#restartDelaysMs[attempt];
		const sessionFile = this.#store.session.sessionFile;
		this.#setConnection({
			state: "restarting",
			detail: `${detail}; restart ${attempt + 1}/${this.#restartDelaysMs.length} in ${delay} ms`,
			executable: this.#options.executable,
		});
		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = undefined;
			if (this.#stopping) return;
			this.#launch({ resumeSessionFile: sessionFile }, "restarting", detail).catch(error => {
				this.#logger.error("OMP restart failed", error);
				if (!this.#stopping) this.#scheduleRestart(`OMP restart failed: ${errorMessage(error)}`);
			});
		}, delay);
	}
}
