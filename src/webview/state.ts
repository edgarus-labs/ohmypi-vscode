import type { WebviewMessage } from "./protocol";

/** The API VS Code injects into the webview (`acquireVsCodeApi()`). */
export interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: SavedState): void;
}

/** What survives a webview reload: the unsent draft and, once the user toggled it, the editor-context choice. */
export interface SavedState {
	draft: string;
	/** Absent until the user toggles editor context; the host's `omp.includeEditorContext` default applies until then. */
	includeContext?: boolean;
}

/** Composer state persisted through the VS Code webview state API. */
export class PersistedState {
	readonly #api: VsCodeApi;
	#draft: string;
	#userIncludeContext: boolean | undefined;
	#hostIncludeContext = false;

	constructor(api: VsCodeApi) {
		this.#api = api;
		const saved = api.getState() as SavedState | undefined;
		this.#draft = saved?.draft ?? "";
		this.#userIncludeContext = saved?.includeContext;
	}

	get draft(): string {
		return this.#draft;
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

	#save(): void {
		this.#api.setState(this.#userIncludeContext === undefined ? { draft: this.#draft } : { draft: this.#draft, includeContext: this.#userIncludeContext });
	}
}
