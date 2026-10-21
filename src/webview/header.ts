import type { ConnectionStatus, SessionView } from "../omp/api";
import { elapsedText } from "../shared/format";
import { isRouterPaused, statusDisplayText, TIER_STATUS_KEY } from "../shared/router";
import { type StateWord, stateWord } from "./chrome";
import { h } from "./dom";
import { icon } from "./icons";
import type { StatusEntry, WebviewCommand, WebviewMessage } from "./protocol";

export interface HeaderState {
	session: SessionView;
	connection: ConnectionStatus;
	pendingInteractions: number;
	unavailable: string | undefined;
}

/**
 * Session title, the activity line (compaction and OMP status texts), the paused tier router's Resume button,
 * the usage button and the state indicator with the elapsed time of the current turn.
 */
export class Header {
	readonly element: HTMLElement;
	readonly #sessionButton: HTMLButtonElement;
	readonly #activity = h("span", { class: "activity" });
	readonly #resumeSlot = h("span", { class: "resume-slot" });
	readonly #resumeButton: HTMLButtonElement;
	readonly #label = h("span", { class: "state-word" });
	/** Outside the `status` region: a ticking counter inside it would be re-announced every second. */
	readonly #elapsed = h("span", { class: "elapsed", attrs: { "aria-hidden": "true" } });
	readonly #stateBox: HTMLElement;
	#state: HeaderState | undefined;
	#statuses: readonly StatusEntry[] = [];
	/** Epoch ms when the current turn started (webview-local). */
	#busySince: number | undefined;
	#busyTimer: number | undefined;

	/** `showUsage` toggles the usage popup. */
	constructor(post: (message: WebviewMessage) => void, showUsage: () => void) {
		this.#sessionButton = h("button", { class: "plain session-title", onClick: () => post({ type: "command", command: "omp.renameSession" }) });
		this.#resumeButton = h(
			"button",
			{
				class: "secondary resume-tier",
				title: "The model was set manually, so the tier router is paused. Sends /tier-auto.",
				attrs: { "aria-label": "Resume tier router auto routing" },
				onClick: () => post({ type: "resumeTierRouter" }),
			},
			"Resume auto",
		);
		const usageButton = h(
			"button",
			{ class: "icon-button usage-button", title: "Usage limits (OMP: Show Usage)", attrs: { "aria-label": "Show usage limits" }, onClick: showUsage },
			icon("gauge"),
		);
		this.#stateBox = h(
			"span",
			{ class: "state hidden" },
			h("span", { class: "state-status", attrs: { role: "status" } }, h("span", { class: "dot", attrs: { "aria-hidden": "true" } }), this.#label),
			this.#elapsed,
		);
		this.element = h(
			"div",
			{ class: "header" },
			this.#sessionButton,
			this.#activity,
			this.#resumeSlot,
			h("span", { class: "spacer" }),
			usageButton,
			this.#stateBox,
		);
	}

	get word(): StateWord {
		const state = this.#state;
		if (!state) return "offline";
		return stateWord({
			connection: state.connection.state,
			phase: state.session.phase,
			pendingInteractions: state.pendingInteractions,
			unavailable: state.unavailable !== undefined,
		});
	}

	render(state: HeaderState): void {
		this.#state = state;
		this.#trackBusy(state.session.phase !== "idle");
		const word = this.word;
		this.#stateBox.className = `state state-${word}${word === "idle" ? " hidden" : ""}`;
		this.#label.textContent = word;
		const { connection, session } = state;
		this.#stateBox.title = `${word} · connection: ${connection.state}${connection.detail ? ` (${connection.detail})` : ""}`;
		this.#sessionButton.textContent = session.sessionName || "New chat";
		this.#sessionButton.title = `${session.sessionName || "New chat"}\n${session.sessionFile ?? "No session file yet"}\nClick to rename`;
		this.#renderElapsed();
		this.#renderActivity();
	}

	/** OMP's current statuses, listed after compaction; a paused tier router offers Resume auto. */
	setStatuses(statuses: readonly StatusEntry[]): void {
		this.#statuses = statuses;
		this.#renderActivity();
		const tier = statuses.find(status => status.key === TIER_STATUS_KEY);
		const paused = tier !== undefined && isRouterPaused(tier.text);
		if ((this.#resumeButton.parentNode === this.#resumeSlot) !== paused) this.#resumeSlot.replaceChildren(...(paused ? [this.#resumeButton] : []));
	}

	#renderElapsed(): void {
		const word = this.word;
		this.#elapsed.textContent = this.#busySince !== undefined && word !== "offline" && word !== "starting" ? elapsedText(Date.now() - this.#busySince) : "";
	}

	#renderActivity(): void {
		const parts = this.#statuses.map(status => statusDisplayText(status.key, status.text));
		if (this.#state?.session.isCompacting) parts.unshift("compacting…");
		const text = parts.join(" · ");
		this.#activity.textContent = text;
		this.#activity.title = text;
	}

	#trackBusy(busy: boolean): void {
		if (!busy) {
			this.#busySince = undefined;
			window.clearInterval(this.#busyTimer);
			this.#busyTimer = undefined;
			return;
		}
		this.#busySince ??= Date.now();
		this.#busyTimer ??= window.setInterval(() => this.#renderElapsed(), 1000);
	}
}

/** Error banner shown while OMP cannot be used, with settings and retry actions. */
export class Banner {
	readonly element = h("div", { class: "banner hidden" });
	readonly #post: (message: WebviewMessage) => void;
	#shown: string | undefined;

	constructor(post: (message: WebviewMessage) => void) {
		this.#post = post;
	}

	/** Shows `unavailable`; the same reason again keeps the banner's nodes (and keyboard focus on its buttons). */
	render(unavailable: string | undefined): void {
		if (unavailable === this.#shown) return;
		this.#shown = unavailable;
		if (!unavailable) {
			this.element.className = "banner hidden";
			this.element.replaceChildren();
			return;
		}
		const command = (name: WebviewCommand) => () => this.#post({ type: "command", command: name });
		this.element.className = "banner";
		this.element.replaceChildren(
			icon("error", 14),
			h("span", { class: "banner-text", title: unavailable }, `OMP not found: ${unavailable}`),
			h("button", { class: "secondary", onClick: command("omp.openSettings") }, "Open Settings"),
			h("button", { class: "secondary", onClick: command("omp.restart") }, "Retry"),
		);
	}
}
