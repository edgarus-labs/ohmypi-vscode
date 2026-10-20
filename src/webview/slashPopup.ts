import type { SlashCommandView } from "../omp/api";
import { h } from "./dom";
import { acceptSuggestion, firstToken, type SlashMenu, slashMenu } from "./slashCommands";

const LISTBOX_ID = "slash-commands";
/** Rows PageUp / PageDown move the active row by. */
const PAGE_ROWS = 8;

/**
 * Autocomplete list for `/` commands attached to a textarea, which it marks up as a combobox.
 * It never sends anything: accepting a row only rewrites the textarea and reports the edit.
 */
export class SlashPopup {
	readonly element = h("div", { class: "slash-menu hidden", attrs: { role: "listbox", id: LISTBOX_ID, "aria-label": "Slash commands" } });
	readonly #input: HTMLTextAreaElement;
	readonly #onEdit: () => void;
	#commands: readonly SlashCommandView[] = [];
	#menu: SlashMenu | undefined;
	#rows: HTMLElement[] = [];
	#active = 0;
	/** First token the list was dismissed for with Escape; the list stays closed until that token changes. */
	#dismissedFor: string | undefined;

	/** `onEdit` runs after an accepted row rewrote the textarea. */
	constructor(input: HTMLTextAreaElement, onEdit: () => void) {
		this.#input = input;
		this.#onEdit = onEdit;
		input.setAttribute("role", "combobox");
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-controls", LISTBOX_ID);
		input.setAttribute("aria-expanded", "false");
	}

	setCommands(commands: readonly SlashCommandView[]): void {
		if (commands === this.#commands) return;
		this.#commands = commands;
		if (this.#menu) this.refresh();
	}

	/** Opens, re-filters or closes the list for the current text and caret. */
	refresh(): void {
		const text = this.#input.value;
		if (this.#dismissedFor !== undefined && firstToken(text) !== this.#dismissedFor) this.#dismissedFor = undefined;
		this.#show(this.#dismissedFor === undefined ? slashMenu(text, this.#input.selectionStart, this.#commands) : undefined);
	}

	close(): void {
		this.#show(undefined);
	}

	/** Handles a key pressed in the textarea while the list is open; true when the key was consumed. */
	handleKey(event: KeyboardEvent): boolean {
		const menu = this.#menu;
		if (!menu) return false;
		const count = menu.items.length;
		switch (event.key) {
			case "Escape":
				this.#dismissedFor = firstToken(this.#input.value);
				this.close();
				return true;
			case "ArrowDown":
			case "ArrowUp":
				if (count === 0) return false;
				this.#activate((this.#active + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
				return true;
			case "PageDown":
			case "PageUp":
				if (count === 0) return false;
				this.#activate(Math.min(count - 1, Math.max(0, this.#active + (event.key === "PageDown" ? PAGE_ROWS : -PAGE_ROWS))));
				return true;
			case "Enter":
			case "Tab":
				if (count === 0 || event.shiftKey) return false;
				this.#accept(this.#active);
				return true;
			default:
				return false;
		}
	}

	#show(menu: SlashMenu | undefined): void {
		this.#menu = menu;
		this.#active = 0;
		this.#rows = menu?.items.map((item, index) => {
			const row = h(
				"div",
				{ class: "slash-option", title: item.description, attrs: { role: "option", id: `${LISTBOX_ID}-${index}`, "aria-selected": "false" } },
				h("strong", { class: "slash-name" }, menu.level === "command" ? `/${item.name}` : item.name),
				item.alias === undefined ? undefined : h("span", { class: "slash-alias" }, `/${item.alias}`),
				item.hint ? h("span", { class: "slash-hint" }, item.hint) : undefined,
				item.description ? h("span", { class: "slash-description" }, item.description) : undefined,
				item.badge ? h("span", { class: "slash-badge" }, item.badge) : undefined,
			);
			row.addEventListener("mousedown", event => {
				event.preventDefault();
				this.#accept(index);
			});
			return row;
		}) ?? [];
		const empty = h(
			"div",
			{ class: "slash-option slash-empty", attrs: { role: "option", "aria-disabled": "true", "aria-selected": "false" } },
			menu?.level === "subcommand" ? "No matching subcommands" : "No matching commands",
		);
		this.element.replaceChildren(...(menu && this.#rows.length === 0 ? [empty] : this.#rows));
		this.element.classList.toggle("hidden", !menu);
		this.#input.setAttribute("aria-expanded", String(menu !== undefined));
		if (this.#rows.length > 0) this.#activate(0);
		else this.#input.removeAttribute("aria-activedescendant");
	}

	#activate(index: number): void {
		this.#rows[this.#active]?.setAttribute("aria-selected", "false");
		this.#active = index;
		const row = this.#rows[index];
		row.setAttribute("aria-selected", "true");
		this.#input.setAttribute("aria-activedescendant", row.id);
		row.scrollIntoView({ block: "nearest" });
	}

	#accept(index: number): void {
		const menu = this.#menu;
		const item = menu?.items[index];
		if (!menu || !item) return;
		const next = acceptSuggestion(this.#input.value, menu, item);
		this.#input.value = next.text;
		this.#input.setSelectionRange(next.caret, next.caret);
		this.#input.focus();
		this.#onEdit();
		this.refresh();
	}
}
