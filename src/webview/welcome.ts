import type { ConnectionStatus } from "../omp/api";
import { relativeTime } from "../shared/format";
import { h } from "./dom";
import { icon } from "./icons";
import type { RecentSession, WebviewMessage } from "./protocol";

export interface WelcomeState {
	/** No conversation yet: the welcome shows. */
	empty: boolean;
	unavailable: string | undefined;
	connection: ConnectionStatus;
}

/** A recent-session button and the parts a refresh updates. */
interface RecentRow {
	button: HTMLButtonElement;
	title: HTMLElement;
	age: HTMLElement;
}

/** The welcome line for the connection state; recent sessions are offered only while OMP is ready. */
function welcomeLine({ unavailable, connection }: WelcomeState): string {
	if (unavailable) return `OMP is not available: ${unavailable}`;
	switch (connection.state) {
		case "starting":
		case "restarting":
			return "Starting OMP…";
		case "failed":
			return connection.detail ? `OMP stopped: ${connection.detail}` : "OMP stopped.";
		case "stopped":
			return "OMP is not running. Send a message or start it now.";
		case "ready":
			return "What should we build?";
	}
}

/**
 * Centered welcome while the conversation is empty: a line that follows the connection, a Start OMP button
 * while OMP is stopped, and recent sessions while it is ready.
 */
export class WelcomeView {
	readonly #line = h("div", { class: "empty-line" });
	readonly #actions = h("div", { class: "empty-actions" });
	readonly #start: HTMLButtonElement;
	readonly #list = h("div", { class: "recent-list" });
	readonly #viewAll: HTMLButtonElement;
	readonly #recentBox: HTMLElement;
	readonly element: HTMLElement;
	readonly #post: (message: WebviewMessage) => void;
	#recent: { sessions: RecentSession[]; total: number } = { sessions: [], total: 0 };
	/** Rendered recent rows by session path; a refresh updates them in place so keyboard focus stays. */
	#rows = new Map<string, RecentRow>();
	#showRecent = false;

	constructor(post: (message: WebviewMessage) => void) {
		this.#post = post;
		this.#start = h("button", { class: "primary start-omp", onClick: () => post({ type: "command", command: "omp.restart" }) }, "Start OMP");
		this.#viewAll = h("button", { class: "link view-all", onClick: () => post({ type: "command", command: "omp.resumeSession" }) });
		this.#recentBox = h(
			"div",
			{ class: "recent hidden", attrs: { role: "group", "aria-label": "Recent sessions" } },
			h("div", { class: "recent-heading" }, "Recent"),
			this.#list,
			this.#viewAll,
		);
		this.element = h("div", { class: "empty hidden" }, h("span", { class: "empty-mark" }, icon("logo", 40)), this.#line, this.#actions, this.#recentBox);
	}

	get visible(): boolean {
		return !this.element.classList.contains("hidden");
	}

	/** Number of recent-session rows currently rendered. */
	get recentRows(): number {
		return this.#list.childElementCount;
	}

	setRecent(sessions: RecentSession[], total: number): void {
		this.#recent = { sessions, total };
	}

	update(state: WelcomeState): void {
		const { empty, unavailable, connection } = state;
		this.element.classList.toggle("hidden", !empty);
		this.#showRecent = empty && !unavailable && connection.state === "ready";
		if (!this.#showRecent) {
			this.#list.replaceChildren();
			this.#recentBox.classList.add("hidden");
		}
		if (!empty) return;
		this.element.classList.toggle("unavailable", unavailable !== undefined);
		this.#line.textContent = welcomeLine(state);
		const showStart = !unavailable && connection.state === "stopped";
		if ((this.#start.parentNode === this.#actions) !== showStart) this.#actions.replaceChildren(...(showStart ? [this.#start] : []));
		if (this.#showRecent) this.renderRecent();
	}

	/** Re-renders the recent rows (their ages are relative to now), keeping the row nodes of sessions still listed. */
	renderRecent(): void {
		if (!this.#showRecent) return;
		const now = Date.now();
		const { sessions, total } = this.#recent;
		const rows = new Map<string, RecentRow>();
		for (const entry of sessions) {
			const row = this.#rows.get(entry.path) ?? this.#recentRow(entry.path);
			row.button.title = entry.title;
			row.title.textContent = entry.title;
			row.age.title = new Date(entry.modified).toLocaleString();
			row.age.textContent = relativeTime(entry.modified, now);
			rows.set(entry.path, row);
		}
		this.#rows = rows;
		const buttons = Array.from(rows.values(), row => row.button);
		if (buttons.length !== this.#list.children.length || buttons.some((button, index) => this.#list.children[index] !== button)) {
			const focused = buttons.find(button => button === document.activeElement);
			this.#list.replaceChildren(...buttons);
			focused?.focus();
		}
		this.#viewAll.textContent = `View all (${total})`;
		this.#viewAll.classList.toggle("hidden", total <= sessions.length);
		this.#recentBox.classList.toggle("hidden", sessions.length === 0);
	}

	#recentRow(path: string): RecentRow {
		const title = h("span", { class: "recent-title" });
		const age = h("span", { class: "recent-age" });
		const button = h("button", { class: "recent-row", onClick: () => this.#post({ type: "openSession", path }) }, title, age);
		return { button, title, age };
	}

	get hasRecent(): boolean {
		return this.#recent.sessions.length > 0;
	}
}
