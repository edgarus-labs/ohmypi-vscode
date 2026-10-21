import * as path from "node:path";
import { errorMessage } from "../shared/errors";
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
	ProviderUsage,
	SessionBinding,
	SessionSummary,
	SessionView,
	ToolExecutionEvent,
	TranscriptItem,
} from "./api";
import { OmpRequestError, type OmpRpcClient, type RequestArgs } from "./client";
import { HostToolCalls } from "./hostTools";
import { type LifecycleTuning, ProcessLifecycle } from "./lifecycle";
import { toModelView } from "./models";
import { PromptTracker } from "./phase";
import { OmpProcess } from "./process";
import type { CommandMap, CommandType, SessionEvent } from "./protocol";
import { SESSION_COMMAND_TIMEOUT_MS, SessionLoader } from "./sessionLoader";
import { listSessions } from "./sessions";
import { toSlashCommands } from "./slashCommands";
import { AUTO_THINKING, selectableLevels } from "./thinking";
import { historyToItems, SessionStore } from "./transcript";
import { UiRequestBroker } from "./uiRequests";
import { fetchUsageJson, type UsageJsonLaunch } from "./usageJson";
import { isUsageReport, parseUsageReport, qualifyUsageBuckets } from "./usageReport";

/** Timing and test seams; production uses the defaults. */
export interface OmpServiceTuning extends LifecycleTuning {
	/** Messages per `get_messages_page` request when loading a session's history. */
	historyPageLimit?: number;
}

const MODEL_DISCOVERY_TIMEOUT_MS = 120_000;
const DEFAULT_HISTORY_PAGE_LIMIT = 256;

/**
 * The host's single entry point to OMP: commands and the session, transcript,
 * agent and interaction state they drive. Process supervision lives in
 * {@link ProcessLifecycle}, session loading in {@link SessionLoader}, UI request
 * mapping in {@link UiRequestBroker}.
 */
export class OmpService implements OmpServiceApi {
	readonly #options: OmpServiceOptions;
	readonly #logger: Logger;
	readonly #store: SessionStore;
	readonly #agentRegistry: AgentRegistry;
	readonly #tracker: PromptTracker;
	readonly #ui: UiRequestBroker;
	readonly #loader: SessionLoader;
	readonly #lifecycle: ProcessLifecycle;
	readonly #hostToolCalls: HostToolCalls | undefined;
	readonly #usageJson: UsageJsonLaunch;
	/** `command_output` texts collected instead of shown while `/usage` runs for {@link getUsage}. */
	#usageCapture: string[] | undefined;
	/** Settles when the usage request in progress has; requests run one at a time. */
	#usageQueue: Promise<unknown> = Promise.resolve();

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

		const onListenerError = (error: unknown) => this.#logger.error("OMP listener failed", error);
		this.#store = new SessionStore(onListenerError);
		this.#agentRegistry = new AgentRegistry(onListenerError);
		this.#tracker = new PromptTracker(phase => this.#store.update({ phase }));
		this.#ui = new UiRequestBroker(this.#logger, text => this.#store.addNotice("warning", text), onListenerError);
		this.#loader = new SessionLoader(
			this.#store,
			this.#agentRegistry,
			this.#logger,
			tuning.historyPageLimit ?? DEFAULT_HISTORY_PAGE_LIMIT,
			options.hostTools?.definitions,
		);
		this.#hostToolCalls = options.hostTools && new HostToolCalls(options.hostTools, this.#logger);
		this.#usageJson = {
			spawn: tuning.spawn ?? (processOptions => new OmpProcess(processOptions)),
			process: { executable: options.executable, cwd: options.cwd, env: options.env, logger: this.#logger },
			logger: this.#logger,
			shutdownGraceMs: tuning.shutdownGraceMs,
		};
		this.#lifecycle = new ProcessLifecycle(
			options,
			tuning,
			{
				attach: (client, isCurrent) => this.#attach(client, isCurrent),
				prepare: async (client, binding) => {
					await this.#loader.configure(client);
					const warning = await this.#loader.bind(client, binding);
					await this.#loader.load(client);
					return warning;
				},
				detached: reason => {
					const headline = reason.split("\n", 1)[0];
					this.#store.interrupt(headline);
					this.#agentRegistry.interruptSubagents(headline);
					this.#store.noteTurnOutcome("error");
					this.#tracker.terminate(reason);
					this.#store.update({ isCompacting: false });
					this.#ui.withdrawAll();
					this.#hostToolCalls?.abortAll();
				},
				notice: (level, text) => this.#store.addNotice(level, text),
				sessionFile: () => this.#store.session.sessionFile,
			},
			onListenerError,
		);

		this.onDidChangeConnection = this.#lifecycle.onDidChange;
		this.onDidChangeSession = this.#store.onDidChangeSession;
		this.onDidChangeTranscriptItem = this.#store.onDidChangeItem;
		this.onDidResetTranscript = this.#store.onDidReset;
		this.onDidChangeAgents = this.#agentRegistry.onDidChange;
		this.onToolExecution = this.#store.onToolExecution;
		this.onInteractionRequest = this.#ui.onRequest;
		this.onInteractionCancelled = this.#ui.onCancelled;
		this.onPresentation = this.#ui.onPresentation;

		this.#store.onDidChangeSession(() => this.#updateMainAgent());
		this.#store.onToolExecution(() => this.#updateMainAgent());
		this.#lifecycle.onDidChange(status => status.state === "ready" && this.#fetchCommands());
	}

	get cwd(): string {
		return this.#options.cwd;
	}

	get connection(): ConnectionStatus {
		return this.#lifecycle.connection;
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

	get statuses(): ReadonlyMap<string, string> {
		return this.#ui.statuses;
	}

	start(options: SessionBinding = {}): Promise<void> {
		return this.#lifecycle.start(options);
	}

	restart(): Promise<void> {
		return this.#lifecycle.restart();
	}

	stop(): Promise<void> {
		return this.#lifecycle.stop();
	}

	dispose(): void {
		this.stop().catch(error => this.#logger.error("Failed to stop OMP", error));
		this.#lifecycle.dispose();
		this.#ui.dispose();
		this.#store.dispose();
		this.#agentRegistry.dispose();
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

	getUsage(): Promise<ProviderUsage[]> {
		const usage = this.#usageQueue.then(() => this.#loadUsage());
		this.#usageQueue = usage.catch(() => undefined);
		return usage;
	}

	addPendingPrompt(text: string, imageCount: number): string | undefined {
		return this.#tracker.phase === "idle" ? this.#store.addPendingUser(text, imageCount) : undefined;
	}

	discardPendingPrompt(id: string): void {
		this.#store.removePendingUser(id);
	}

	prompt(text: string, mode: PromptMode = "auto", images: readonly PromptImage[] = [], pendingItemId?: string): Promise<PromptOutcome> {
		const client = this.#lifecycle.readyClient;
		if (!client) {
			if (pendingItemId !== undefined) this.#store.removePendingUser(pendingItemId);
			return Promise.reject(this.#lifecycle.notRunning());
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
		let admitted = false;
		client.request("prompt", params, { id, timeoutMs: 0 }).then(
			ack => {
				admitted = true;
				this.#tracker.acknowledged(id, ack?.agentInvoked);
			},
			error => this.#tracker.rejected(id, errorMessage(error)),
		);
		return outcome.then(result => {
			if (pendingItemId !== undefined) {
				if (admitted) this.#store.confirmPendingUser(pendingItemId);
				else this.#store.removePendingUser(pendingItemId);
			}
			if (result.status === "error" && result.error) this.#store.update({ lastError: result.error });
			return result;
		});
	}

	async abort(): Promise<void> {
		this.#tracker.abortRequested();
		const subagents = this.#agentRegistry.agents.filter(agent => agent.id !== "main" && (agent.status === "running" || agent.status === "pending"));
		await this.#request("abort");
		await Promise.all(
			subagents.map(({ id }) =>
				this.#request("cancel_subagent", { subagentId: id }).catch(error => this.#logger.warn(`Cancelling subagent ${id} after abort failed`, error)),
			),
		);
	}

	async newSession(): Promise<void> {
		const { cancelled } = await this.#request("new_session", {}, { timeoutMs: SESSION_COMMAND_TIMEOUT_MS });
		if (cancelled) throw new Error("Creating a new session was cancelled by an OMP extension");
		await this.#loader.load(this.#requireClient());
	}

	async switchSession(sessionFile: string): Promise<void> {
		const { cancelled } = await this.#request(
			"switch_session",
			{ sessionPath: sessionFile },
			{ timeoutMs: SESSION_COMMAND_TIMEOUT_MS },
		);
		if (cancelled) throw new Error("Switching sessions was cancelled by an OMP extension");
		await this.#loader.load(this.#requireClient());
	}

	async setSessionName(name: string): Promise<void> {
		await this.#request("set_session_name", { name });
		this.#store.update({ sessionName: name });
	}

	async listSessions(): Promise<SessionSummary[]> {
		const sessionFile = this.#store.session.sessionFile;
		return sessionFile ? listSessions(path.dirname(sessionFile), this.#logger) : [];
	}

	respondInteraction(id: string, response: InteractionResponse): void {
		this.#ui.respond(this.#lifecycle.client, id, response);
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
			this.#requireClient();
			this.prompt(message, "steer").catch(error => this.#logger.error("Steering the main agent failed", error));
			return;
		}
		await this.#request("steer_subagent", { subagentId: agentId, message });
	}

	async getAgentTranscript(agentId: string): Promise<TranscriptItem[]> {
		if (agentId === "main") return [...this.#store.transcript];
		const { messages } = await this.#request("get_subagent_messages", { subagentId: agentId });
		const status = this.#agentRegistry.agents.find(agent => agent.id === agentId)?.status;
		return historyToItems(messages, { running: status === "running" || status === "pending" });
	}

	// -------------------------------------------------------------------------

	/**
	 * Sends `/usage` as a plain prompt (no transcript row, no prompt tracking) and reads the report from the
	 * command output captured meanwhile; `omp usage --json` runs alongside to name the quota buckets.
	 */
	async #loadUsage(): Promise<ProviderUsage[]> {
		const client = this.#requireClient();
		const capture: string[] = [];
		this.#usageCapture = capture;
		const buckets = fetchUsageJson(this.#usageJson);
		try {
			await client.request("prompt", { message: "/usage" });
		} finally {
			this.#usageCapture = undefined;
		}
		const text = capture.map(output => `${output}\n`).join("");
		if (!isUsageReport(text)) throw new Error("OMP printed no usage report");
		const providers = parseUsageReport(text);
		const json = await buckets;
		if (json !== undefined) qualifyUsageBuckets(providers, json);
		return providers;
	}

	#requireClient(): OmpRpcClient {
		const client = this.#lifecycle.readyClient;
		if (!client) throw this.#lifecycle.notRunning();
		return client;
	}

	#request<K extends CommandType>(type: K, ...args: RequestArgs<K>): Promise<CommandMap[K]["result"]> {
		const client = this.#lifecycle.readyClient;
		return client ? client.request(type, ...args) : Promise.reject(this.#lifecycle.notRunning());
	}

	async #refreshThinkingLevels(): Promise<void> {
		const { levels } = await this.#request("get_available_thinking_levels");
		this.#store.update({ availableThinkingLevels: selectableLevels(levels, this.#store.session.model?.reasoning === true) });
	}

	/** Background refresh after events that change state without carrying it. */
	#refreshState(withThinkingLevels = false): void {
		const refresh = async () => {
			this.#store.applyState(await this.#request("get_state"));
			if (withThinkingLevels) await this.#refreshThinkingLevels();
		};
		refresh().catch(error => {
			if (error instanceof OmpRequestError && error.code === "closed") return;
			this.#logger.warn("Refreshing OMP state failed", error);
		});
	}

	/** Asks the ready process for its slash commands; the answer is dropped once that process is let go. */
	#fetchCommands(): void {
		const client = this.#lifecycle.readyClient;
		if (!client) return;
		client
			.request("get_available_commands")
			.then(result => {
				if (this.#lifecycle.readyClient === client) this.#applyCommands(result?.commands);
			})
			.catch(error => {
				if (error instanceof OmpRequestError && error.code === "closed") return;
				this.#logger.warn("Fetching OMP slash commands (get_available_commands) failed", error);
			});
	}

	#applyCommands(payload: unknown): void {
		const commands = toSlashCommands(payload);
		if (!commands) {
			this.#logger.warn(`OMP slash commands ignored: expected a list, got ${payload === null ? "null" : typeof payload}`);
			return;
		}
		this.#store.update({ commands });
	}

	#updateMainAgent(): void {
		const { phase, model } = this.#store.session;
		this.#agentRegistry.setMain({
			phase,
			model: model ? `${model.provider}/${model.id}` : undefined,
			activity: this.#store.runningTool,
		});
	}

	#attach(client: OmpRpcClient, current: () => boolean): void {
		client.onSessionEvent(event => current() && this.#onSessionEvent(event));
		this.#hostToolCalls?.attach(client, current);
		client.onPromptResult(frame => {
			if (!current()) return;
			this.#store.noteTurnOutcome(frame.status);
			this.#tracker.promptResult(frame);
			if (frame.status === "error" && frame.error) this.#store.update({ lastError: frame.error.message });
		});
		client.onSessionSettled(() => current() && this.#tracker.sessionSettled());
		client.onUiRequest(request => current() && this.#ui.handle(client, request));
		client.onSubagentFrame(frame => current() && this.#agentRegistry.applyFrame(frame));
		client.onCommandOutput(frame => {
			if (!current()) return;
			if (this.#usageCapture) this.#usageCapture.push(frame.text);
			else this.#store.addCommandOutput(frame.text);
		});
		client.onSessionInfoUpdate(frame => {
			if (current() && frame.title !== undefined) this.#store.update({ sessionName: frame.title });
		});
		client.onConfigUpdate(() => current() && this.#refreshState(true));
		client.onAvailableCommands(frame => current() && this.#applyCommands(frame.commands));
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
}
