import type { RenderedReport, WebviewMessage } from "./protocol";

/** Posts what is rendered back to the host, at most once per task, and only while extension tests asked for it. */
export class RenderReporter {
	readonly #post: (message: WebviewMessage) => void;
	readonly #collect: () => RenderedReport;
	#scheduled = false;
	/** `reset.testHooks`: off outside extension tests. */
	enabled = false;

	constructor(post: (message: WebviewMessage) => void, collect: () => RenderedReport) {
		this.#post = post;
		this.#collect = collect;
	}

	schedule(): void {
		if (!this.enabled || this.#scheduled) return;
		this.#scheduled = true;
		setTimeout(() => {
			this.#scheduled = false;
			this.#post({ type: "rendered", ...this.#collect() });
		}, 0);
	}
}
