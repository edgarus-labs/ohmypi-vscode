import type { Attachment, WebviewMessage } from "./protocol";

/** The API VS Code injects into the webview (`acquireVsCodeApi()`). */
export interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: SavedState): void;
}

/** What survives a webview reload: the unsent draft with its attachments and, once the user toggled it, the editor-context choice. */
export interface SavedState {
	draft: string;
	/** Absent until the user toggles editor context; the host's `omp.includeEditorContext` default applies until then. */
	includeContext?: boolean;
	/** The draft's file and pasted-text attachments. */
	attachments?: Attachment[];
	/** Labels of the draft's images; their bytes are too large to save on every keystroke, so a reload loses them. */
	imageLabels?: string[];
}

/** Composer state persisted through the VS Code webview state API. */
export class PersistedState {
	readonly #api: VsCodeApi;
	#draft: string;
	#userIncludeContext: boolean | undefined;
	#hostIncludeContext = false;
	#attachments: Attachment[];
	#imageLabels: string[];
	/** Images attached before the reload this state was restored from; reported once. */
	#lostImages: string[];

	constructor(api: VsCodeApi) {
		this.#api = api;
		const saved = api.getState() as SavedState | undefined;
		this.#draft = saved?.draft ?? "";
		this.#userIncludeContext = saved?.includeContext;
		this.#attachments = saved?.attachments ?? [];
		this.#imageLabels = [];
		this.#lostImages = saved?.imageLabels ?? [];
	}

	get draft(): string {
		return this.#draft;
	}

	/** File and pasted-text attachments restored from the saved state. */
	get attachments(): readonly Attachment[] {
		return this.#attachments;
	}

	get includeContext(): boolean {
		return this.#userIncludeContext ?? this.#hostIncludeContext;
	}

	/** The host's `omp.includeEditorContext` setting, used until the user toggles editor context. */
	setHostDefault(includeEditorContext: boolean): void {
		this.#hostIncludeContext = includeEditorContext;
	}

	toggleIncludeContext(): void {
		this.#userIncludeContext = !this.includeContext;
		this.#save();
	}

	setDraft(draft: string): void {
		this.#draft = draft;
		this.#save();
	}

	setAttachments(attachments: readonly Attachment[]): void {
		this.#attachments = attachments.filter(attachment => attachment.kind !== "image");
		this.#imageLabels = attachments.flatMap(attachment => (attachment.kind === "image" ? [attachment.label] : []));
		this.#save();
	}

	/** Labels of the images the restored draft had and the reload lost; empty after the first call. */
	takeLostImages(): string[] {
		const lost = this.#lostImages;
		this.#lostImages = [];
		return lost;
	}

	#save(): void {
		this.#api.setState({
			draft: this.#draft,
			...(this.#userIncludeContext === undefined ? {} : { includeContext: this.#userIncludeContext }),
			...(this.#attachments.length > 0 ? { attachments: this.#attachments } : {}),
			...(this.#imageLabels.length > 0 ? { imageLabels: this.#imageLabels } : {}),
		});
	}
}
