import type { SessionPhase } from "../omp/api";
import { compactTokens, elapsedText } from "../shared/format";
import { h } from "./dom";

export interface WorkingState {
	/** The session phase, `submitting` while a prompt sent from the composer waits for the host. */
	phase: SessionPhase;
	isCompacting: boolean;
	pendingInteractions: number;
	/** Epoch ms the turn started; unknown outside a turn (background work). */
	startedAt: number | undefined;
	outputTokens: number | undefined;
}

export interface WorkingIndicatorOptions {
	now?: () => number;
	prefersReducedMotion?: () => boolean;
}

type WorkingStatus = "sending" | "working" | "compacting" | "stopping" | "background";

const FIXED_LABELS: Record<Exclude<WorkingStatus, "working">, string> = {
	sending: "Sending…",
	compacting: "Compacting…",
	stopping: "Stopping…",
	background: "Waiting for background work…",
};

export const WORKING_VERBS = ["Thinking", "Working", "Reading", "Planning", "Writing", "Checking", "Exploring", "Reasoning"] as const;

/** Grows and shrinks again. */
const GLYPHS = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"];
const STILL_GLYPH = "✻";
const FRAME_MS = 120;
/** Only the elapsed time changes when motion is reduced. */
const STILL_FRAME_MS = 1000;
/** How long each verb stays: the first 2 s, the next 3 s, every later one 5 s. */
const VERB_HOLD_MS = [2000, 3000, 5000];
const SCRAMBLE_FRAMES = 4;
const SCRAMBLE_CHARS = "abcdefghijklmnopqrstuvwxyz";

/** What the row says, or undefined while it is hidden: idle, or OMP waits for an answer the interaction card asks for. */
function workingStatus(state: WorkingState): WorkingStatus | undefined {
	if (state.pendingInteractions > 0) return undefined;
	if (state.phase === "aborting") return "stopping";
	if (state.isCompacting) return "compacting";
	switch (state.phase) {
		case "idle":
			return undefined;
		case "submitting":
			return "sending";
		case "yielded":
			return "background";
		case "running":
			return "working";
	}
}

function prefersReducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The last row of the conversation while the agent is busy: an animated glyph, what it does, the elapsed
 * time of the turn and its output tokens. Animated and ticking parts are hidden from screen readers and
 * the row is no live region (the header's status announces state changes once). One interval drives the
 * row while it is shown.
 */
export class WorkingIndicator {
	readonly element: HTMLElement;
	readonly #glyph = h("span", { class: "working-glyph", attrs: { "aria-hidden": "true" } });
	readonly #label = h("span", { class: "working-label", attrs: { "aria-hidden": "true" } });
	readonly #detail = h("span", { class: "working-detail", attrs: { "aria-hidden": "true" } });
	readonly #now: () => number;
	readonly #prefersReducedMotion: () => boolean;
	#state: WorkingState | undefined;
	#status: WorkingStatus | undefined;
	/** When the current status began; the elapsed time outside a turn counts from here. */
	#statusSince = 0;
	#timer: number | undefined;
	#still = false;
	#frame = 0;
	#verb: string = WORKING_VERBS[0];
	#verbSince = 0;
	#verbChanges = 0;
	/** Frames left until the new verb is fully revealed. */
	#scramble = 0;

	constructor(options: WorkingIndicatorOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#prefersReducedMotion = options.prefersReducedMotion ?? prefersReducedMotion;
		this.element = h("div", { class: "working hidden" }, this.#glyph, this.#label, this.#detail, h("span", { class: "sr-only" }, "OMP is working"));
	}

	get visible(): boolean {
		return this.#status !== undefined;
	}

	render(state: WorkingState): void {
		this.#state = state;
		const status = workingStatus(state);
		const appearing = this.#status === undefined;
		if (status !== this.#status) {
			this.#statusSince = this.#now();
			this.#verbSince = this.#statusSince;
		}
		this.#status = status;
		this.element.classList.toggle("hidden", status === undefined);
		if (status === undefined) {
			window.clearInterval(this.#timer);
			this.#timer = undefined;
			return;
		}
		if (appearing) {
			this.#still = this.#prefersReducedMotion();
			this.#frame = 0;
			this.#verbChanges = 0;
			this.#scramble = 0;
			this.#pickVerb(WORKING_VERBS);
		}
		this.#paint();
		this.#timer ??= window.setInterval(() => this.#tick(), this.#still ? STILL_FRAME_MS : FRAME_MS);
	}

	#pickVerb(choices: readonly string[]): void {
		this.#verb = choices[Math.floor(Math.random() * choices.length)] ?? this.#verb;
		this.#verbSince = this.#now();
	}

	#tick(): void {
		this.#frame += 1;
		if (this.#scramble > 0) this.#scramble -= 1;
		const hold = VERB_HOLD_MS[Math.min(this.#verbChanges, VERB_HOLD_MS.length - 1)];
		if (this.#status === "working" && this.#now() - this.#verbSince >= hold) {
			this.#pickVerb(WORKING_VERBS.filter(verb => verb !== this.#verb));
			this.#verbChanges += 1;
			if (!this.#still) this.#scramble = SCRAMBLE_FRAMES;
		}
		this.#paint();
	}

	/** The verb with its not yet revealed letters scrambled. */
	#shownVerb(): string {
		if (this.#scramble === 0) return this.#verb;
		const revealed = Math.floor((this.#verb.length * (SCRAMBLE_FRAMES - this.#scramble)) / SCRAMBLE_FRAMES);
		let text = this.#verb.slice(0, revealed);
		for (let i = revealed; i < this.#verb.length; i++) text += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
		return text;
	}

	#paint(): void {
		const status = this.#status;
		const state = this.#state;
		if (status === undefined || !state) return;
		const label = status === "working" ? `${this.#shownVerb()}…` : FIXED_LABELS[status];
		const glyph = this.#still ? STILL_GLYPH : GLYPHS[this.#frame % GLYPHS.length];
		let detail = elapsedText(this.#now() - (state.startedAt ?? this.#statusSince));
		if (status === "working" && state.outputTokens) detail += ` · ↓ ${compactTokens(state.outputTokens)} tokens`;
		if (this.#glyph.textContent !== glyph) this.#glyph.textContent = glyph;
		if (this.#label.textContent !== label) this.#label.textContent = label;
		if (this.#detail.textContent !== detail) this.#detail.textContent = detail;
	}
}
