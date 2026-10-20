import type { OpenState } from "./dom";
import type { WebviewMessage } from "./protocol";

/** What transcript renderers need: posting to the host, remembered expand state and OMP's working directory. */
export interface RenderContext extends OpenState {
	post(message: WebviewMessage): void;
	/** OMP working directory; paths under it render relative in collapsed rows. */
	cwd?: string;
}

/**
 * Expand state of collapsible sections by key, kept across re-renders of the same item.
 * History item ids are positional, so the state must be cleared when another session is shown.
 */
export class OpenStateStore implements OpenState {
	readonly #open = new Map<string, boolean>();

	isOpen(key: string): boolean | undefined {
		return this.#open.get(key);
	}

	setOpen(key: string, open: boolean): void {
		this.#open.set(key, open);
	}

	clear(): void {
		this.#open.clear();
	}
}
