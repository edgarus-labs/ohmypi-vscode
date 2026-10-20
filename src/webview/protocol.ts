import type {
	ConnectionStatus,
	InteractionRequest,
	InteractionResponse,
	PromptMode,
	ProviderUsage,
	SessionView,
	TranscriptItem,
} from "../omp/api";

export interface PendingInteraction {
	request: InteractionRequest;
	/** Epoch ms when OMP's timeout fires; absent when the request has no timeout. */
	expiresAt?: number;
}

/** Something attached to the next prompt; shown as a removable chip above the input. */
export type Attachment =
	| { id: string; kind: "file"; /** Absolute path; sent to OMP as an `@path` mention. */ path: string; label: string }
	| { id: string; kind: "text"; text: string; label: string }
	| { id: string; kind: "image"; /** Base64 bytes. */ data: string; mimeType: string; label: string };

/** A saved session offered in the empty chat state. */
export interface RecentSession {
	/** Session file; sent back in `openSession`. */
	path: string;
	/** Session title, else its first user message, else the file name. */
	title: string;
	/** Last modification, epoch ms. */
	modified: number;
}

/** Commands the webview may ask the host to run; the host rejects any other `command` message. */
export const WEBVIEW_COMMANDS = [
	"omp.selectModel",
	"omp.resumeSession",
	"omp.renameSession",
	"omp.toggleFastMode",
	"omp.openSettings",
	"omp.restart",
] as const;

export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];

export function isWebviewCommand(value: unknown): value is WebviewCommand {
	return typeof value === "string" && (WEBVIEW_COMMANDS as readonly string[]).includes(value);
}

/** Outcome of the `send` with the same id: `ok` once the prompt was handed to OMP; the webview keeps the draft until then. */
export interface SendResult {
	id: string;
	ok: boolean;
	/** Why the prompt was not sent (set when `ok` is false). */
	error?: string;
}

/** A status OMP set (`setStatus`); the raw text, in the order each key was first set. */
export interface StatusEntry {
	key: string;
	text: string;
}

/** Answer to `loadUsage` with the same id. */
export type UsageResult = { id: string; providers: ProviderUsage[] } | { id: string; error: string };

/** Extension → webview. */
export type HostMessage =
	| {
			type: "reset";
			items: TranscriptItem[];
			session: SessionView;
			connection: ConnectionStatus;
			interactions: PendingInteraction[];
			includeEditorContext: boolean;
			/** Set when OMP cannot be used (e.g. executable not found). */
			unavailable?: string;
			/** OMP working directory, for showing tool paths relative to it. */
			cwd?: string;
			/** The webview posts `rendered` reports only when set (extension tests). */
			testHooks: boolean;
			statuses: StatusEntry[];
			/** Keys of the todo lists the user closed, newest first. */
			dismissedTodos: string[];
	  }
	| ({ type: "sendResult" } & SendResult)
	| { type: "item"; item: TranscriptItem }
	| { type: "session"; session: SessionView }
	| { type: "connection"; connection: ConnectionStatus }
	| { type: "interaction"; pending: PendingInteraction }
	| { type: "interactionClosed"; id: string }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	| { type: "setComposer"; text: string }
	| { type: "focusComposer" }
	| { type: "addAttachments"; attachments: Attachment[] }
	/** Newest saved sessions other than the current one (at most 5) and how many exist in total. */
	| { type: "recentSessions"; sessions: RecentSession[]; total: number }
	| { type: "statuses"; statuses: StatusEntry[] }
	/** Opens the usage popup, or closes it when open (`OMP: Show Usage`). */
	| { type: "toggleUsage" }
	| ({ type: "usage" } & UsageResult);

/** Rendered state posted back to the host for extension tests (only when `reset.testHooks` is set). */
export interface RenderedReport {
	/** Rendered transcript nodes per `TranscriptItem` kind. */
	counts: Record<string, number>;
	lastAssistantText?: string;
	/** Ids of pending interactions currently rendered. */
	interactions: string[];
	/** Tool rows currently rendered collapsed. */
	collapsedTools?: number;
	/** Labels of the attachment chips currently above the input. */
	attachments?: string[];
	/** Number of recent-session rows currently rendered. */
	recentSessions?: number;
}

/** Webview → extension. */
export type WebviewMessage =
	| { type: "ready" }
	| { type: "send"; id: string; text: string; mode: PromptMode; includeContext: boolean; attachments: Attachment[] }
	| { type: "pickContext" }
	| { type: "abort" }
	| { type: "command"; command: WebviewCommand }
	| { type: "setThinkingLevel"; level: string }
	| { type: "openFile"; path: string; line?: number }
	/** `path`: one file of the call, as the call names it; omitted for the call's first diffable file. */
	| { type: "openDiff"; toolCallId: string; path?: string }
	/** A web (`http`/`https`) or `mailto` link clicked in the chat; the host refuses any other scheme. */
	| { type: "openExternal"; url: string }
	| { type: "showAgents" }
	| { type: "respond"; id: string; response: InteractionResponse }
	| { type: "openSession"; path: string }
	/** Sends `/tier-auto` to resume the paused tier router. */
	| { type: "resumeTierRouter" }
	| { type: "loadUsage"; id: string }
	/** The user closed the todo list whose content gives `key`. */
	| { type: "dismissTodos"; key: string }
	| ({ type: "rendered" } & RenderedReport);
