/**
 * Host-facing view models and service contract shared by the OMP runtime layer
 * (`src/omp`) and the VS Code layer (`src/ui`, `src/vscode`, `src/extension.ts`).
 *
 * Everything under `src/omp` is free of the `vscode` module so it runs in plain
 * Node unit tests. Events follow the `vscode.Event` call shape.
 */

export interface Disposable {
	dispose(): void;
}

export type Event<T> = (listener: (value: T) => void) => Disposable;

/** Every level takes the failure that caused the message; sinks render it with its stack, `code` and `command`. */
export interface Logger {
	error(message: string, error?: unknown): void;
	warn(message: string, error?: unknown): void;
	info(message: string, error?: unknown): void;
	debug(message: string, error?: unknown): void;
	/** Whether RPC frames are traced right now; read per frame, so it may change at any time. */
	readonly traceEnabled: boolean;
	/** One RPC frame; callers check {@link traceEnabled} first and pass already-redacted text. */
	trace(direction: "in" | "out", frame: string): void;
}

export type ConnectionState = "stopped" | "starting" | "ready" | "restarting" | "failed";

export interface ConnectionStatus {
	state: ConnectionState;
	/** Human readable reason for `failed`/`restarting`, or the last exit description. */
	detail?: string;
	pid?: number;
	executable?: string;
	/** OMP protocol version negotiated with the process (1 or 2). */
	protocolVersion?: number;
}

/**
 * Prompt/session lifecycle.
 * idle → submitting (prompt sent, not admitted) → running (admitted / agent_start)
 *      → yielded (prompt_result received, sessionSettled=false; background work may wake the agent)
 *      → idle (session_settled, or prompt_result with sessionSettled=true, or agentInvoked=false).
 * `aborting` is entered by abort() while a prompt is open or the agent runs, and lasts until neither is the case.
 */
export type SessionPhase = "idle" | "submitting" | "running" | "yielded" | "aborting";

export interface ModelView {
	provider: string;
	id: string;
	name: string;
	api?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning: boolean;
	/** Supported thinking efforts reported by OMP for this model (empty when none). */
	thinkingEfforts: string[];
	/** Input modalities, e.g. ["text","image"]. */
	input: string[];
	/** USD per million tokens, when OMP reports input and output pricing; unreported cache rates are 0. */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** How OMP classifies the model (vendor class, family, revision such as `5.5.0`), when it does. */
	identity?: { class?: string; family?: string; revision?: string };
}

export interface TodoTaskView {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked" | string;
}

export interface TodoPhaseView {
	name: string;
	tasks: TodoTaskView[];
}

export interface SessionView {
	phase: SessionPhase;
	sessionId?: string;
	sessionFile?: string;
	sessionName?: string;
	model?: ModelView;
	/** Effective level OMP uses; with `auto` selected, the provisional or resolved effort. */
	thinkingLevel?: string;
	/** The user's selector (OMP `configured`): `auto` or an explicit level. */
	thinkingSelector?: string;
	/** The effort `auto` resolved to for the current turn, once OMP classified it. */
	thinkingResolved?: string;
	/** Selectable selectors: `off`, `auto` for reasoning models, then the model's efforts. */
	availableThinkingLevels: string[];
	fastModeEnabled?: boolean;
	fastModeActive?: boolean;
	isCompacting: boolean;
	queue: { steering: string[]; followUp: string[] };
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
	todos: TodoPhaseView[];
	/** Cumulative cost of the session in USD when known (from usage on assistant messages). */
	costUsd?: number;
	/** Last prompt/turn error, cleared when the next prompt is submitted. */
	lastError?: string;
	/** Slash commands OMP accepts, in OMP order. */
	commands: readonly SlashCommandView[];
	/** The turn in progress, absent between turns. */
	turn?: TurnProgressView;
}

export interface SlashCommandView {
	/** Without the leading `/`. */
	name: string;
	source: string;
	aliases: readonly string[];
	description?: string;
	/** OMP `input.hint`, e.g. `[level]`. */
	hint?: string;
	subcommands: readonly { name: string; description?: string; usage?: string }[];
}

export interface ToolResultView {
	/** Concatenated text content of the tool result. */
	text: string;
	isError: boolean;
	/** Raw tool `details` object (tool-specific; e.g. edit's `path`/`diff`/`oldText`/`perFileResults`). */
	details?: unknown;
}

export interface UsageView {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd?: number;
}

/** How a turn ended: `aborted` when the user stopped it, `error` when OMP or the model failed. */
export type TurnStatus = "completed" | "aborted" | "error";

export interface TurnProgressView {
	/** Epoch ms when the prompt was submitted or the agent woke up. */
	startedAt: number;
	/** Output tokens of the turn's finished assistant messages. */
	outputTokens: number;
}

export type TranscriptItem =
	| {
			kind: "user";
			id: string;
			text: string;
			imageCount?: number;
			/** Shown before OMP recorded the prompt; OMP's user message replaces it in place. */
			pending?: boolean;
			/** What OMP expanded the typed slash command in `text` to. */
			expandedText?: string;
	  }
	| {
			kind: "assistant";
			/** OMP `messageId` (stable across start/update/end). */
			id: string;
			text: string;
			thinking: string;
			streaming: boolean;
			model?: string;
			stopReason?: string;
			errorMessage?: string;
			usage?: UsageView;
	  }
	| {
			kind: "tool";
			/** OMP `toolCallId`. */
			id: string;
			name: string;
			args: unknown;
			/** `unresolved`: a stored call with no recorded result (interrupted, or still running elsewhere). */
			status: "running" | "done" | "error" | "unresolved";
			/** Latest partial output streamed by tool_execution_update, plain text. */
			partial?: string;
			result?: ToolResultView;
			startedAt: number;
			endedAt?: number;
	  }
	| { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string }
	| { kind: "command_output"; id: string; text: string }
	| {
			/** Closes a turn the agent worked on; follows the turn's last item. */
			kind: "turn_summary";
			id: string;
			status: TurnStatus;
			/** Absent when unknown (stored messages without timestamps). */
			durationMs?: number;
			/** Sum over the turn's assistant messages; `costUsd` absent when none reported a cost. */
			usage: UsageView;
	  };

/** Emitted for every tool execution boundary; consumed by change tracking. */
export interface ToolExecutionEvent {
	phase: "start" | "end";
	toolCallId: string;
	name: string;
	args: unknown;
	/** Present on `end`. */
	result?: ToolResultView;
}

export interface PromptOutcome {
	status: "completed" | "aborted" | "error" | "local";
	error?: string;
	sessionSettled: boolean;
}

export type PromptMode = "auto" | "steer" | "followUp";

/** An image sent with a prompt (OMP `ImageContent` without the type tag). */
export interface PromptImage {
	/** Base64-encoded bytes. */
	data: string;
	mimeType: string;
}

export interface SessionSummary {
	path: string;
	id?: string;
	title?: string;
	firstMessage?: string;
	cwd?: string;
	modified: number;
	size: number;
}

export type AgentStatus = "running" | "completed" | "failed" | "aborted" | "pending";

export interface AgentView {
	/** "main" for the session's own agent; otherwise the OMP subagent id. */
	id: string;
	parentId?: string;
	/** Agent type/name (e.g. "task", "scout", "reviewer"). */
	name: string;
	description?: string;
	model?: string;
	status: AgentStatus;
	/** Current activity: the running tool or the latest progress line. */
	activity?: string;
	toolCount?: number;
	tokens?: number;
	costUsd?: number;
	startedAt?: number;
	endedAt?: number;
	sessionFile?: string;
	error?: string;
}

export interface AskQuestionView {
	id: string;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string; preview?: string }>;
	multi?: boolean;
	recommended?: number;
}

export type InteractionRequest =
	| { id: string; kind: "confirm"; title: string; message?: string; timeoutMs?: number }
	| {
			id: string;
			kind: "select";
			title: string;
			options: Array<{ label: string; description?: string }>;
			timeoutMs?: number;
	  }
	| { id: string; kind: "input"; title: string; placeholder?: string; timeoutMs?: number }
	| { id: string; kind: "editor"; title: string; prefill?: string }
	| { id: string; kind: "ask"; questions: AskQuestionView[]; timeoutMs?: number };

export type InteractionResponse =
	| { kind: "value"; value: string }
	| { kind: "confirmed"; confirmed: boolean }
	| { kind: "cancelled" }
	| { kind: "answers"; answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> };

/** Fire-and-forget presentation requests from OMP extensions/tools. */
export type PresentationRequest =
	| { kind: "notify"; message: string; level: "info" | "warning" | "error" }
	| { kind: "status"; key: string; text?: string }
	| { kind: "openUrl"; url: string; instructions?: string }
	| { kind: "editorText"; text: string };

/** One rate limit of a provider, from OMP's `/usage` report. */
export interface UsageLimit {
	/** Limit name, qualified with its quota bucket when `omp usage --json` names one. */
	name: string;
	account: string;
	/** 0–100, rounded to two decimals. */
	usedPercent: number;
	/** The current session draws on this limit. */
	inUse: boolean;
	/** When the limit resets, as OMP words it (e.g. `in 4h`). */
	resets?: string;
}

/** A configured provider and its rate limits. */
export interface ProviderUsage {
	provider: string;
	limits: UsageLimit[];
}

export interface OmpServiceOptions {
	/** Resolved absolute executable path. */
	executable: string;
	/** Arguments appended after `--mode rpc-ui`. */
	extraArgs: string[];
	cwd: string;
	/** Environment of the OMP process (default: the host's). */
	env?: Record<string, string | undefined>;
	logger: Logger;
	autoRestart: boolean;
	/** Default per-request timeout (ms); long-running commands use their own. */
	requestTimeoutMs?: number;
	/** Tools of the host that OMP's agent may call; registered with every OMP process the service starts. */
	hostTools?: HostTools;
}

/** A host tool as OMP's agent sees it. */
export interface HostToolDefinition {
	name: string;
	description: string;
	/** JSON schema of the tool's arguments object. */
	parameters: Record<string, unknown>;
}

/** The part of `AbortSignal` a host tool sees (this module stays free of DOM and Node types). */
export interface HostToolSignal {
	readonly aborted: boolean;
	readonly reason: unknown;
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}

/** Tools the host runs for OMP's agent. */
export interface HostTools {
	readonly definitions: readonly HostToolDefinition[];
	/**
	 * Runs tool `name`: resolves to the text the agent reads, rejects with the error it reads instead.
	 * `signal` aborts when OMP cancels the call or its process goes away.
	 */
	invoke(name: string, args: Record<string, unknown>, signal: HostToolSignal): Promise<string>;
}

/** Which session OMP binds when it starts. */
export interface SessionBinding {
	/** Resume this session file; a missing file starts a new session instead. */
	resumeSessionFile?: string;
	newSession?: boolean;
}

/**
 * True for the rejection of a start whose launch was cancelled by a later
 * `restart()`/`stop()`; it reports no failure to the user.
 */
export function isSupersededError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "superseded";
}

/**
 * Owns the OMP child process, the RPC client and the session/agent state that
 * survives restarts. Implemented in `src/omp/service.ts`.
 */
export interface OmpServiceApi extends Disposable {
	readonly cwd: string;
	readonly connection: ConnectionStatus;
	readonly session: SessionView;
	readonly transcript: readonly TranscriptItem[];
	readonly agents: readonly AgentView[];
	/**
	 * Status texts OMP set (`setStatus`) by key, in the order each key was first set. Cleared when the process
	 * ends, with an `onPresentation` status withdrawal for every key.
	 */
	readonly statuses: ReadonlyMap<string, string>;

	readonly onDidChangeConnection: Event<ConnectionStatus>;
	readonly onDidChangeSession: Event<SessionView>;
	/** Fires with the item that was added or changed (streaming updates included). */
	readonly onDidChangeTranscriptItem: Event<TranscriptItem>;
	/** Fires when the transcript was replaced wholesale (new/switched session, history load) or an item was removed. */
	readonly onDidResetTranscript: Event<readonly TranscriptItem[]>;
	readonly onDidChangeAgents: Event<readonly AgentView[]>;
	readonly onToolExecution: Event<ToolExecutionEvent>;
	readonly onInteractionRequest: Event<InteractionRequest>;
	/** OMP withdrew a pending interaction (timeout/abort); close its UI. */
	readonly onInteractionCancelled: Event<string>;
	readonly onPresentation: Event<PresentationRequest>;

	/** Spawn, handshake, configure subscriptions, and optionally bind a session. Clears a pending automatic restart. */
	start(options?: SessionBinding): Promise<void>;
	/** Stop and start again, re-binding the current session file; cancels a launch in flight. */
	restart(): Promise<void>;
	/** Graceful shutdown: close stdin, wait, then terminate the process tree; cancels a launch in flight. */
	stop(): Promise<void>;

	listModels(): Promise<ModelView[]>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	setFastMode(enabled: boolean): Promise<void>;
	/**
	 * Rate limits per provider from OMP's `/usage`, kept off the transcript; limits are named by quota bucket
	 * when `omp usage --json` succeeds. One request runs at a time. Rejects when OMP printed no usage report.
	 */
	getUsage(): Promise<ProviderUsage[]>;

	/**
	 * Shows the user's prompt in the transcript at once as a pending user item, before it is sent.
	 * Returns its id for {@link prompt}, or `undefined` while the agent is busy (steering and follow-ups
	 * show in the queue instead).
	 */
	addPendingPrompt(text: string, imageCount: number): string | undefined;
	/** Removes a pending prompt item whose prompt is not going to be sent. */
	discardPendingPrompt(id: string): void;
	/**
	 * Send user input. `auto`: plain prompt when idle, `steer` while the agent works; while idle every mode
	 * sends a plain prompt. Rejects when OMP is not ready; any later failure resolves with status `error`.
	 * Resolves at the prompt's completion (`prompt_result` or local completion), not at acknowledgement.
	 * `pendingItemId` (from {@link addPendingPrompt}) is removed when OMP does not admit the prompt and
	 * stays, no longer pending, when the prompt completes without OMP recording a user message.
	 */
	prompt(text: string, mode?: PromptMode, images?: readonly PromptImage[], pendingItemId?: string): Promise<PromptOutcome>;
	/** Stops the turn and cancels every running or pending subagent; resolves once OMP accepted the abort. */
	abort(): Promise<void>;
	newSession(): Promise<void>;
	switchSession(sessionFile: string): Promise<void>;
	setSessionName(name: string): Promise<void>;
	/** Sessions stored next to the current session file, newest first. */
	listSessions(): Promise<SessionSummary[]>;

	/**
	 * Answer a pending interaction. Unknown or withdrawn ids are ignored; throws when the
	 * answer cannot be delivered, and the interaction then stays pending.
	 */
	respondInteraction(id: string, response: InteractionResponse): void;

	cancelAgent(agentId: string): Promise<boolean>;
	/**
	 * "main" steers the session's own turn, or starts a new one when the turn has ended meanwhile; rejects when OMP
	 * is not running and reports a failed prompt in `session.lastError`. Others steer a subagent.
	 */
	steerAgent(agentId: string, message: string): Promise<void>;
	/**
	 * Transcript of a subagent; while it runs, the calls of its last reply without a result are running.
	 * "main" returns the current session transcript.
	 */
	getAgentTranscript(agentId: string): Promise<TranscriptItem[]>;
	/** Stops OMP in the background; no listener is notified from now on. */
	dispose(): void;
}
