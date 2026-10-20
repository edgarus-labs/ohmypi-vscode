import type { TranscriptItem } from "../omp/api";
import type { RenderContext } from "./context";
import { h, patchElement } from "./dom";
import { renderItem } from "./messages";

/**
 * The conversation column: one node per transcript item, then the optional trailing row (the working
 * indicator). Streaming replies and tool rows are patched in place. The column is not a live region
 * (streaming would re-announce whole messages); finished replies and notices are passed to `announce`
 * once instead.
 */
export class TranscriptView {
	readonly element = h("div", { class: "column", attrs: { role: "log", "aria-live": "off", "aria-label": "Conversation" } });
	readonly #ctx: RenderContext;
	readonly #announce: (text: string) => void;
	readonly #nodes = new Map<string, HTMLElement>();
	/** Assistant replies already announced or restored by a reset. */
	readonly #settled = new Set<string>();
	#localNoticeSequence = 0;
	readonly #tail: HTMLElement | null;

	constructor(ctx: RenderContext, announce: (text: string) => void, tail?: HTMLElement) {
		this.#ctx = ctx;
		this.#announce = announce;
		this.#tail = tail ?? null;
		if (tail) this.element.append(tail);
	}

	reset(items: readonly TranscriptItem[]): void {
		this.#nodes.clear();
		this.#settled.clear();
		this.element.replaceChildren(...(this.#tail ? [this.#tail] : []));
		for (const item of items) {
			if (item.kind === "assistant" && !item.streaming) this.#settled.add(item.id);
			this.#place(item);
		}
	}

	upsert(item: TranscriptItem): void {
		this.#place(item);
		if (item.kind === "assistant" && !item.streaming && item.text && !this.#settled.has(item.id)) {
			this.#settled.add(item.id);
			this.#announce(item.text);
		}
	}

	/** A notice raised by the webview or the host outside OMP's transcript. */
	notice(level: "info" | "warning" | "error", text: string): void {
		this.#place({ kind: "notice", id: `local-${++this.#localNoticeSequence}`, level, text });
		this.#announce(text);
	}

	get isEmpty(): boolean {
		return this.#nodes.size === 0;
	}

	/** Whether anything other than notices is shown. */
	get hasConversation(): boolean {
		for (const node of this.#nodes.values()) if (node.dataset.kind !== "notice") return true;
		return false;
	}

	/** Rendered nodes per item kind. */
	counts(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const el of this.#nodes.values()) {
			const kind = el.dataset.kind;
			if (kind && el.isConnected) counts[kind] = (counts[kind] ?? 0) + 1;
		}
		return counts;
	}

	lastAssistantText(): string | undefined {
		const assistants = this.element.querySelectorAll<HTMLElement>('[data-kind="assistant"] > .md');
		return assistants.length > 0 ? (assistants[assistants.length - 1].textContent ?? "") : undefined;
	}

	/** Tool rows shown closed (header and preview only). */
	collapsedTools(): number {
		return this.element.querySelectorAll('[data-kind="tool"]:not(.expanded)').length;
	}

	/** Patches the node of an updated reply or tool call, replaces other changed items, appends new ones. */
	#place(item: TranscriptItem): void {
		const el = renderItem(item, this.#ctx);
		const previous = this.#nodes.get(item.id);
		if (!previous) {
			this.element.insertBefore(el, this.#tail);
			this.#nodes.set(item.id, el);
		} else if ((item.kind === "assistant" || item.kind === "tool") && !el.classList.contains("notice") && !previous.classList.contains("notice")) {
			patchElement(previous, el);
		} else {
			previous.replaceWith(el);
			this.#nodes.set(item.id, el);
		}
	}
}
