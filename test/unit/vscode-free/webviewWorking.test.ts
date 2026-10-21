import * as assert from "node:assert/strict";
import type { SessionView, TranscriptItem } from "../../../src/omp/api";
import { emptySessionView } from "../../../src/shared/session";
import { startWebviewApp, type WebviewApp } from "../../../src/webview/app";
import { WORKING_VERBS, WorkingIndicator, type WorkingState } from "../../../src/webview/working";
import { click, event, type FakeVsCodeApi, fakeVsCodeApi, liveIntervals, type ResetMessage, settle, useDom } from "./webviewDom";

const VERB_LABELS: readonly string[] = WORKING_VERBS.map(verb => `${verb}…`);

function state(overrides: Partial<WorkingState> = {}): WorkingState {
	return { phase: "running", isCompacting: false, pendingInteractions: 0, startedAt: undefined, outputTokens: undefined, ...overrides };
}

describe("WorkingIndicator", () => {
	useDom();
	let clock: { now: number };
	let indicator: WorkingIndicator;
	const label = () => indicator.element.querySelector(".working-label")?.textContent ?? "";
	const detail = () => indicator.element.querySelector(".working-detail")?.textContent ?? "";
	const glyph = () => indicator.element.querySelector(".working-glyph")?.textContent ?? "";
	const shown = () => !indicator.element.classList.contains("hidden");

	beforeEach(() => {
		clock = { now: 100_000 };
		indicator = new WorkingIndicator({ now: () => clock.now });
		document.body.append(indicator.element);
	});

	it("says what the agent does in each busy phase", () => {
		const labels = (["submitting", "aborting", "yielded"] as const).map(phase => {
			indicator.render(state({ phase }));
			return label();
		});
		assert.deepEqual(labels, ["Sending…", "Stopping…", "Waiting for background work…"]);
		indicator.render(state({ isCompacting: true }));
		assert.equal(label(), "Compacting…");
		indicator.render(state());
		assert.ok(VERB_LABELS.includes(label()), label());
	});

	it("shows the elapsed time of the turn and, while running, its output tokens", () => {
		indicator.render(state({ phase: "submitting", startedAt: clock.now - 12_400, outputTokens: 1_234 }));
		assert.equal(detail(), "12s");
		indicator.render(state({ startedAt: clock.now - 65_000, outputTokens: 1_234 }));
		assert.equal(detail(), "1m 05s · ↓ 1.2k tokens");
		indicator.render(state({ startedAt: clock.now, outputTokens: 0 }));
		assert.equal(detail(), "0s");
	});

	it("hides while the session is idle or OMP waits for an answer, without a timer left running", () => {
		const before = liveIntervals();
		indicator.render(state());
		assert.ok(shown());
		assert.equal(liveIntervals(), before + 1);
		indicator.render(state({ phase: "aborting" }));
		assert.equal(liveIntervals(), before + 1, "one interval for the row");
		indicator.render(state({ pendingInteractions: 1 }));
		assert.equal(shown(), false);
		assert.equal(liveIntervals(), before);
		indicator.render(state());
		indicator.render(state({ phase: "idle" }));
		assert.equal(shown(), false);
		assert.equal(liveIntervals(), before);
	});

	it("is no live region: only a hidden text names the activity to screen readers", () => {
		indicator.render(state());
		const el = indicator.element;
		assert.equal(el.querySelectorAll("[aria-live], [role]").length + (el.hasAttribute("aria-live") || el.hasAttribute("role") ? 1 : 0), 0);
		for (const part of [".working-glyph", ".working-label", ".working-detail"]) {
			assert.equal(el.querySelector(part)?.getAttribute("aria-hidden"), "true", part);
		}
		assert.deepEqual(
			Array.from(el.children)
				.filter(child => child.getAttribute("aria-hidden") !== "true")
				.map(child => [child.className, child.textContent]),
			[["sr-only", "OMP is working"]],
		);
	});

	it("animates the glyph and moves on to another verb after two seconds", async () => {
		indicator.render(state({ startedAt: clock.now }));
		const first = label();
		const glyphs = new Set([glyph()]);
		for (let i = 0; i < 3; i++) {
			await settle(130);
			glyphs.add(glyph());
		}
		assert.ok(glyphs.size > 1, "the glyph cycles");
		assert.equal(label(), first, "the verb stays for two seconds");
		clock.now += 2_000;
		await settle(800);
		assert.ok(VERB_LABELS.includes(label()), label());
		assert.notEqual(label(), first);
	});

	it("keeps the glyph still and swaps verbs without scrambling when motion is reduced", async () => {
		indicator.render(state({ phase: "idle" }));
		indicator = new WorkingIndicator({ now: () => clock.now, prefersReducedMotion: () => true });
		document.body.append(indicator.element);
		indicator.render(state({ startedAt: clock.now }));
		const still = glyph();
		const first = label();
		clock.now += 2_000;
		await settle(1_100);
		assert.equal(glyph(), still);
		assert.ok(VERB_LABELS.includes(label()), label());
		assert.notEqual(label(), first);
	});
});

describe("webview working row", () => {
	useDom();
	let api: FakeVsCodeApi;
	let root: HTMLElement;
	let app: WebviewApp;

	const session = (overrides: Partial<SessionView> = {}): SessionView => ({ ...emptySessionView(), ...overrides });
	const reset = (overrides: Partial<ResetMessage> = {}): ResetMessage => ({
		type: "reset",
		items: [],
		session: session(),
		connection: { state: "ready" },
		interactions: [],
		includeEditorContext: true,
		testHooks: false,
		statuses: [],
		dismissedTodos: [],
		...overrides,
	});
	const row = () => root.querySelector(".working");
	const shown = () => row()?.classList.contains("hidden") === false;
	const label = () => row()?.querySelector(".working-label")?.textContent ?? "";

	function send(text: string): string {
		const input = root.querySelector("textarea.input") as HTMLTextAreaElement;
		input.value = text;
		input.dispatchEvent(event("input"));
		click(root.querySelector("button.send"));
		const sent = api.postedOf("send").at(-1);
		assert.ok(sent);
		return sent.id;
	}

	beforeEach(() => {
		api = fakeVsCodeApi();
		root = document.createElement("div");
		document.body.append(root);
		app = startWebviewApp(api, root);
		app.handle(reset());
	});

	it("appears as soon as a prompt is sent and stays the last row of the conversation until the turn ends", () => {
		const before = liveIntervals();
		const id = send("hi");
		assert.ok(shown(), "shown before the host answers");
		assert.equal(label(), "Sending…");
		assert.equal(root.querySelector(".column")?.classList.contains("hidden"), false, "shown in an empty conversation");
		app.handle({ type: "item", item: { kind: "user", id: "u1", text: "hi", pending: true } });
		app.handle({ type: "sendResult", id, ok: true });
		assert.ok(shown(), "still shown until the host reports the turn");
		app.handle({ type: "session", session: session({ phase: "submitting", turn: { startedAt: Date.now(), outputTokens: 0 } }) });
		app.handle({ type: "session", session: session({ phase: "running", turn: { startedAt: Date.now(), outputTokens: 0 } }) });
		assert.ok(VERB_LABELS.includes(label()), label());
		const reply: TranscriptItem = { kind: "assistant", id: "a1", text: "hello", thinking: "", streaming: false };
		app.handle({ type: "item", item: reply });
		assert.ok(root.querySelector(".column")?.lastElementChild === row(), "the row follows the newest item");
		app.handle({ type: "session", session: session() });
		assert.equal(shown(), false);
		assert.equal(liveIntervals(), before);
	});

	it("hides while OMP waits for an answer to its question", () => {
		app.handle({ type: "session", session: session({ phase: "running" }) });
		assert.ok(shown());
		app.handle({ type: "interaction", pending: { request: { id: "q1", kind: "confirm", title: "Go?" } } });
		assert.equal(shown(), false);
		app.handle({ type: "interactionClosed", id: "q1" });
		assert.ok(shown());
	});

	it("goes away when the host could not send the prompt", () => {
		const id = send("hi");
		app.handle({ type: "sendResult", id, ok: false, error: "OMP is not running" });
		assert.equal(shown(), false);
	});

	it("goes away when the host finished the prompt without a turn", () => {
		const id = send("/rules");
		app.handle({ type: "sendResult", id, ok: true });
		app.handle({ type: "session", session: session() });
		assert.equal(shown(), false);
	});

	it("stays while OMP starts and loads the session before taking the prompt", () => {
		send("hi");
		app.handle(reset({ connection: { state: "starting" } }));
		app.handle({ type: "session", session: session({ sessionId: "s1" }) });
		assert.ok(shown());
		assert.equal(label(), "Sending…");
	});

	it("shows a turn summary as a line under the turn", () => {
		app.handle({
			type: "item",
			item: {
				kind: "turn_summary",
				id: "turn-1",
				status: "completed",
				durationMs: 72_000,
				usage: { input: 12_300, output: 2_100, cacheRead: 0, cacheWrite: 0, costUsd: 0.0123 },
			},
		});
		const line = root.querySelector('.item.turn-summary[data-kind="turn_summary"]');
		assert.equal(line?.textContent, "Worked 1m 12s · 12.3k in · 2.1k out · $0.0123");
		assert.ok(line?.nextElementSibling === row(), "the working row stays last");
	});
});
