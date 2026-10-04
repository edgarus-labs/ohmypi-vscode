import type {
	ConnectionStatus,
	InteractionRequest,
	InteractionResponse,
	PromptMode,
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
	  }
	| { type: "item"; item: TranscriptItem }
	| { type: "session"; session: SessionView }
	| { type: "connection"; connection: ConnectionStatus }
	| { type: "interaction"; pending: PendingInteraction }
	| { type: "interactionClosed"; id: string }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	| { type: "setComposer"; text: string }
	| { type: "focusComposer" }
	| { type: "addAttachments"; attachments: Attachment[] };

export type TranscriptKind = TranscriptItem["kind"];

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
}

/** Webview → extension. */
export type WebviewMessage =
	| { type: "ready" }
	| { type: "send"; text: string; mode: PromptMode; includeContext: boolean; attachments: Attachment[] }
	| { type: "pickContext" }
	| { type: "abort" }
	| {
			type: "command";
			command: "omp.selectModel" | "omp.newSession" | "omp.resumeSession" | "omp.renameSession" | "omp.toggleFastMode" | "omp.openSettings" | "omp.restart";
	  }
	| { type: "setThinkingLevel"; level: string }
	| { type: "openFile"; path: string; line?: number }
	| { type: "openDiff"; toolCallId?: string; path?: string }
	| { type: "showAgents" }
	| { type: "respond"; id: string; response: InteractionResponse }
	| ({ type: "rendered" } & RenderedReport);
