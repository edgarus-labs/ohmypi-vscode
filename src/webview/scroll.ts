import { isAtBottom } from "./chrome";
import { h } from "./dom";
import { icon } from "./icons";

/** Scroll area that follows new output only while the reader is already at the bottom. */
export class ScrollArea {
	readonly element: HTMLElement;
	readonly #scroller: HTMLElement;
	readonly #jump: HTMLButtonElement;
	#stick = true;

	constructor(...content: HTMLElement[]) {
		this.#scroller = h("div", { class: "scroller" }, ...content);
		this.#jump = h(
			"button",
			{
				class: "jump hidden",
				title: "Scroll to the latest output",
				attrs: { "aria-label": "Jump to latest" },
				onClick: () => this.toBottom(),
			},
			icon("arrowDown", 14),
		);
		this.element = h("div", { class: "main" }, this.#scroller, this.#jump);
		this.#scroller.addEventListener("scroll", () => {
			this.#stick = isAtBottom(this.#scroller.scrollHeight, this.#scroller.scrollTop, this.#scroller.clientHeight);
			this.#jump.classList.toggle("hidden", this.#stick);
		});
		const observer = new ResizeObserver(() => {
			if (this.#stick) this.#scrollDown();
		});
		observer.observe(this.#scroller);
		for (const element of content) observer.observe(element);
	}

	/** Sticks to the bottom again and scrolls there. */
	toBottom(): void {
		this.#stick = true;
		this.#scrollDown();
	}

	/** After new output: scroll along when sticking, else offer the jump button. */
	follow(): void {
		if (this.#stick) this.#scrollDown();
		else this.#jump.classList.remove("hidden");
	}

	#scrollDown(): void {
		this.#scroller.scrollTop = this.#scroller.scrollHeight;
		this.#jump.classList.add("hidden");
	}
}
