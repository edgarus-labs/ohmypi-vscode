/**
 * OMP RPC wire types, a hand-trimmed subset of
 * `packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts` (OMP 18.5.1).
 * Only the commands and frames this client uses are described; unknown frame
 * types still decode as {@link UnknownFrame}.
 */

/** The single object guard for decoded wire values; fields remain `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}

export type UserContent = TextContent | ImageContent;
export type MessageContent = string | UserContent[];
export type AssistantContent = TextContent | ThinkingContent | ImageContent | ToolCall | { type: string };

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: UsageCost;
	contextTokens?: number;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface UserMessage {
	role: "user";
	content: MessageContent;
	timestamp: number;
	synthetic?: boolean;
	attribution?: "user" | "agent";
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: StopReason;
	timestamp: number;
	errorMessage?: string;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: UserContent[];
	isError: boolean;
	timestamp: number;
	details?: unknown;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	cancelled: boolean;
	truncated: boolean;
	timestamp: number;
	exitCode?: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	timestamp: number;
}

/** Other roles (developer, custom, hookMessage, …) are carried but not rendered. */
export interface OtherMessage {
	role: string;
	timestamp?: number;
}

export type AgentMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| BashExecutionMessage
	| CompactionSummaryMessage
	| OtherMessage;

export type AssistantMessageEvent =
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number }
	| { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| { type: "start" | "done" | "error" | "image_end"; [key: string]: unknown };

export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ThinkingConfig {
	mode: string;
	efforts: string[];
	defaultLevel?: string;
}

export interface ModelInfo {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
	cost: ModelCost;
	contextWindow: number | null;
	maxTokens: number | null;
	thinking?: ThinkingConfig;
}

export interface TodoItem {
	content: string;
	status: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export interface SessionState {
	sessionId: string;
	model?: ModelInfo;
	thinkingLevel?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	sessionFile?: string;
	sessionName?: string;
	fastModeEnabled?: boolean;
	fastModeActive?: boolean;
	messageCount?: number;
	hasPendingAsyncWork?: boolean;
	isSettled?: boolean;
	queuedMessages?: { steering: string[]; followUp: string[] };
	todoPhases?: TodoPhase[];
	contextUsage?: ContextUsage;
}

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** Subset of OMP's `AgentProgress` record carried by subagent snapshots and progress frames. */
export interface SubagentProgress {
	id?: string;
	status?: SubagentStatus;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolIntent?: string;
	recentOutput?: string[];
	toolCount?: number;
	tokens?: number;
	cost?: number;
	durationMs?: number;
	resolvedModel?: string;
	retryFailure?: { attempt: number; errorMessage: string };
	error?: string;
}

export interface SubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: string;
	status: SubagentStatus;
	lastUpdate: number;
	description?: string;
	task?: string;
	assignment?: string;
	sessionFile?: string;
	progress?: SubagentProgress;
	parentToolCallId?: string;
}

export interface SubagentMessages {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	messages: AgentMessage[];
}

export interface MessagesPage {
	messages: AgentMessage[];
	totalMessages: number;
	nextCursor?: string;
}

/** Parameters and successful `data` of each command this client sends. */
export interface CommandMap {
	negotiate_protocol: { params: { protocolVersion: number }; result: { protocolVersion: number } };
	prompt: {
		params: { message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" };
		result: { agentInvoked?: boolean } | undefined;
	};
	abort: { params: undefined; result: undefined };
	new_session: { params: { parentSession?: string }; result: { cancelled: boolean } };
	switch_session: { params: { sessionPath: string }; result: { cancelled: boolean } };
	get_state: { params: undefined; result: SessionState };
	set_fast_mode: { params: { enabled: boolean }; result: { enabled: boolean; active: boolean } };
	set_ask_dialog: { params: { enabled: boolean }; result: { enabled: boolean } };
	set_subagent_subscription: { params: { level: "off" | "progress" | "events" }; result: { level: string } };
	set_event_filter: {
		params: { events: string[] | null; messageUpdates?: "full" | "delta" };
		result: { events: string[] | null; messageUpdates?: "full" | "delta" };
	};
	get_subagents: { params: undefined; result: { subagents: SubagentSnapshot[] } };
	get_subagent_messages: {
		params: { subagentId?: string; sessionFile?: string; fromByte?: number };
		result: SubagentMessages;
	};
	cancel_subagent: { params: { subagentId: string }; result: { cancelled: boolean } };
	steer_subagent: { params: { subagentId: string; message: string }; result: undefined };
	set_model: { params: { provider: string; modelId: string }; result: ModelInfo };
	get_available_models: { params: undefined; result: { models: ModelInfo[] } };
	set_thinking_level: { params: { level: string }; result: undefined };
	get_available_thinking_levels: { params: undefined; result: { levels: string[] } };
	set_session_name: { params: { name: string }; result: undefined };
	get_messages: { params: undefined; result: { messages: AgentMessage[] } };
	get_messages_page: { params: { cursor?: string; limit?: number }; result: MessagesPage };
	get_entries: { params: { since?: string } | undefined; result: { entries: SessionEntry[]; leafId: string | null } };
}

/** A durable session journal entry (open record; only the fields read here are typed). */
export interface SessionEntry {
	type: string;
	id?: string;
	/** On `thinking_level_change` entries: the effective level. */
	thinkingLevel?: string | null;
	/** On `thinking_level_change` entries: the user's selector (`"auto"`) when it differs. */
	configured?: string | null;
}

export type CommandType = keyof CommandMap;

// ---------------------------------------------------------------------------
// Outbound (server → client) frames
// ---------------------------------------------------------------------------

export interface ReadyFrame {
	type: "ready";
	protocolVersion?: number;
	supportedProtocolVersions?: number[];
	maxFrameBytes?: number;
	maxReassembledFrameBytes?: number;
}

export interface ResponseFrame {
	type: "response";
	command: string;
	success: boolean;
	id?: string;
	data?: unknown;
	error?: string;
	code?: string;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface PromptResultFrame {
	type: "prompt_result";
	agentInvoked: boolean;
	status: "completed" | "aborted" | "error";
	sessionSettled: boolean;
	id?: string;
	error?: { message: string; retryable: boolean; provider?: string; model?: string; httpStatus?: number };
}

export interface SessionSettledFrame {
	type: "session_settled";
}

export interface AgentStartEvent {
	type: "agent_start";
}
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
	isTerminal?: boolean;
	yielded?: boolean;
	awaitingAsyncWork?: boolean;
}
export interface TurnStartEvent {
	type: "turn_start";
}
export interface TurnEndEvent {
	type: "turn_end";
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
	messageId?: string;
}
export interface MessageUpdateEvent {
	type: "message_update";
	/** Full partial message, or only `{ role }` under the `messageUpdates: "delta"` projection. */
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
	messageId?: string;
}
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
	messageId?: string;
}
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args?: unknown;
	intent?: string;
}
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args?: unknown;
	partialResult?: unknown;
}
export interface ToolStreamUpdateEvent {
	type: "tool_stream_update";
	toolCallId: string;
	toolName: string;
	update?: unknown;
}
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result?: unknown;
	isError?: boolean;
}
export interface QueueUpdateEvent {
	type: "queue_update";
	steering: string[];
	followUp: string[];
}
export interface ModelChangedEvent {
	type: "model_changed";
}
export interface ThinkingLevelChangedEvent {
	type: "thinking_level_changed";
	thinkingLevel?: string;
	configured?: string;
	resolved?: string;
}
export interface NoticeEvent {
	type: "notice";
	level: "info" | "warning" | "error";
	message: string;
	source?: string;
}
export interface AutoCompactionStartEvent {
	type: "auto_compaction_start";
	reason: string;
	action: string;
}
export interface AutoCompactionEndEvent {
	type: "auto_compaction_end";
	action: string;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
	skipped?: boolean;
}
export interface AutoRetryStartEvent {
	type: "auto_retry_start";
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}
export interface AutoRetryEndEvent {
	type: "auto_retry_end";
	success: boolean;
	attempt: number;
	finalError?: string;
}

export type SessionEvent =
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolStreamUpdateEvent
	| ToolExecutionEndEvent
	| QueueUpdateEvent
	| ModelChangedEvent
	| ThinkingLevelChangedEvent
	| NoticeEvent
	| AutoCompactionStartEvent
	| AutoCompactionEndEvent
	| AutoRetryStartEvent
	| AutoRetryEndEvent;

export type SessionEventType = SessionEvent["type"];

/**
 * Every session event type OMP 18.5 may emit. Types without a typed shape
 * above are still routed as session events (and ignored by the reducers).
 */
export const SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_stream_update",
	"tool_execution_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"cache_warming_start",
	"cache_warming_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"model_changed",
	"config_warnings_changed",
	"advisor_cost_changed",
	"advisor_yielded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
	"queue_update",
]);

export interface AskQuestion {
	id: string;
	question: string;
	options: Array<{ label: string; description?: string; preview?: string }>;
	header?: string;
	multi?: boolean;
	recommended?: number;
}

interface UiRequestBase {
	type: "extension_ui_request";
	id: string;
}

export type ExtensionUiRequest = UiRequestBase &
	(
		| {
				method: "select";
				title: string;
				options: string[];
				optionDetails?: Array<{ description?: string }>;
				timeout?: number;
		  }
		| { method: "confirm"; title: string; message: string; timeout?: number }
		| { method: "input"; title: string; placeholder?: string; timeout?: number }
		| { method: "editor"; title: string; prefill?: string; promptStyle?: boolean }
		| { method: "ask"; questions: AskQuestion[]; timeout?: number }
		| { method: "cancel"; targetId: string }
		| { method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
		| { method: "setStatus"; statusKey: string; statusText?: string }
		| { method: "setWidget"; widgetKey: string; widgetLines?: string[] }
		| { method: "setTitle"; title: string }
		| { method: "set_editor_text"; text: string }
		| { method: "open_url"; url: string; launchUrl?: string; instructions?: string }
	);

export type ExtensionUiResponse = { type: "extension_ui_response"; id: string } & (
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true; timedOut?: boolean }
	| { answers: Array<{ id: string; selectedOptions: string[]; customInput?: string }> }
);

export interface HostToolCallFrame {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

export interface HostUriRequestFrame {
	type: "host_uri_request";
	id: string;
	operation: "read" | "write";
	url: string;
	content?: string;
}

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: string;
	status: "started" | "completed" | "failed" | "aborted";
	index: number;
	description?: string;
	sessionFile?: string;
	parentToolCallId?: string;
	detached?: boolean;
}

export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: string;
	task: string;
	progress: SubagentProgress;
	parentToolCallId?: string;
	assignment?: string;
	sessionFile?: string;
}

export type SubagentFrame =
	| { type: "subagent_lifecycle"; payload: SubagentLifecyclePayload }
	| { type: "subagent_progress"; payload: SubagentProgressPayload }
	| { type: "subagent_event"; payload: { id: string; event: { type: string } } };

export interface CommandOutputFrame {
	type: "command_output";
	text: string;
}

export interface SessionInfoUpdateFrame {
	type: "session_info_update";
	sessionId: string;
	title?: string;
}

export interface ConfigUpdateFrame {
	type: "config_update";
	model?: ModelInfo;
	thinkingLevel?: string;
}

export interface UnknownFrame {
	type: string;
	[key: string]: unknown;
}
