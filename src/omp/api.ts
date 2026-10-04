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

export interface Logger {
	error(message: string, error?: unknown): void;
	warn(message: string): void;
	info(message: string): void;
	debug(message: string): void;
	/** RPC frame trace; only emitted when tracing is enabled. Callers pass already-redacted text. */
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
 * `aborting` is entered by abort() and left on the next prompt_result/agent_end/session_settled.
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
	/** USD per million tokens, when OMP reports pricing. */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
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
	isStreaming: boolean;
	isCompacting: boolean;
	queue: { steering: string[]; followUp: string[] };
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
	todos: TodoPhaseView[];
	/** Cumulative cost of the session in USD when known (from usage on assistant messages). */
	costUsd?: number;
	/** Last prompt/turn error, cleared when the next prompt is submitted. */
	lastError?: string;
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

export type TranscriptItem =
	| { kind: "user"; id: string; text: string; imageCount?: number }
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
			status: "running" | "done" | "error";
			/** Latest streamed partial output (tool_execution_update / tool_stream_update), plain text. */
			partial?: string;
			result?: ToolResultView;
			startedAt: number;
			endedAt?: number;
	  }
	| { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string }
	| { kind: "command_output"; id: string; text: string };

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
	| {
			id: string;
			kind: "input";
			title: string;
			placeholder?: string;
			/** Render masked and never echo/log the value. */
			secret: boolean;
			timeoutMs?: number;
	  }
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

export interface OmpServiceOptions {
	/** Resolved absolute executable path. */
	executable: string;
	/** Arguments appended after `--mode rpc-ui`. */
	extraArgs: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	logger: Logger;
	autoRestart: boolean;
	/** Default per-request timeout (ms); long-running commands use their own. */
	requestTimeoutMs?: number;
	/** Pass abbreviated, redacted RPC frames to `logger.trace`. Off by default (formatting every frame costs CPU). */
	traceRpc?: boolean;
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

	readonly onDidChangeConnection: Event<ConnectionStatus>;
	readonly onDidChangeSession: Event<SessionView>;
	/** Fires with the item that was added or changed (streaming updates included). */
	readonly onDidChangeTranscriptItem: Event<TranscriptItem>;
	/** Fires when the transcript was replaced wholesale (new/switched session, history load). */
	readonly onDidResetTranscript: Event<readonly TranscriptItem[]>;
	readonly onDidChangeAgents: Event<readonly AgentView[]>;
	readonly onToolExecution: Event<ToolExecutionEvent>;
	readonly onInteractionRequest: Event<InteractionRequest>;
	/** OMP withdrew a pending interaction (timeout/abort); close its UI. */
	readonly onInteractionCancelled: Event<string>;
	readonly onPresentation: Event<PresentationRequest>;

	/** Spawn, handshake, configure subscriptions, and optionally bind a session. */
	start(options?: { resumeSessionFile?: string; newSession?: boolean }): Promise<void>;
	/** Stop and start again, re-binding the current session file. */
	restart(): Promise<void>;
	/** Graceful shutdown: close stdin, wait, then terminate the process tree. */
	stop(): Promise<void>;

	listModels(): Promise<ModelView[]>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	setFastMode(enabled: boolean): Promise<void>;

	/**
	 * Send user input. `auto`: plain prompt when idle, `steer` while the agent works.
	 * Resolves at the prompt's completion (`prompt_result` or local completion), not at acknowledgement.
	 */
	prompt(text: string, mode?: PromptMode, images?: readonly PromptImage[]): Promise<PromptOutcome>;
	abort(): Promise<void>;
	newSession(): Promise<void>;
	switchSession(sessionFile: string): Promise<void>;
	setSessionName(name: string): Promise<void>;
	/** Sessions stored next to the current session file, newest first. */
	listSessions(): Promise<SessionSummary[]>;

	respondInteraction(id: string, response: InteractionResponse): void;

	cancelAgent(agentId: string): Promise<boolean>;
	steerAgent(agentId: string, message: string): Promise<void>;
	/** Transcript of a subagent ("main" returns the current session transcript). */
	getAgentTranscript(agentId: string): Promise<TranscriptItem[]>;
}
