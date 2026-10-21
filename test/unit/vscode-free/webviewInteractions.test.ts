import * as assert from "node:assert/strict";
import { InteractionsView } from "../../../src/webview/interactions";
import type { PendingInteraction, WebviewMessage } from "../../../src/webview/protocol";
import { click, event, focused, liveIntervals, useDom } from "./webviewDom";

describe("InteractionsView", () => {
	useDom();
	let posted: WebviewMessage[];
	let announced: string[];
	let composerFocused: boolean;
	let composerFocusCalls: number;
	let view: InteractionsView;

	beforeEach(() => {
		posted = [];
		announced = [];
		composerFocused = false;
		composerFocusCalls = 0;
		view = new InteractionsView({
			post: message => posted.push(message),
			announce: text => announced.push(text),
			composerHasFocus: () => composerFocused,
			focusComposer: () => composerFocusCalls++,
		});
		document.body.append(view.element);
	});

	it("announces a new question as a labelled region and focuses its first control", () => {
		view.add({ request: { id: "c1", kind: "confirm", title: "Run rm -rf build?", message: "Deletes the build folder" } });
		const card = view.element.querySelector(".interaction");
		assert.equal(card?.getAttribute("role"), "region");
		const titleId = card?.getAttribute("aria-labelledby");
		assert.ok(titleId);
		assert.equal(card?.querySelector(`#${titleId}`)?.textContent, "Run rm -rf build?");
		assert.deepEqual(announced, ["OMP asks: Run rm -rf build?"]);
		assert.equal(focused.at(-1)?.textContent, "Approve");
	});

	it("leaves focus in the composer while the user is typing there", () => {
		composerFocused = true;
		view.add({ request: { id: "c1", kind: "confirm", title: "Proceed?" } });
		assert.equal(focused.length, 0);
	});

	it("leaves focus in another card's text field while the user is typing there", () => {
		view.add({ request: { id: "i1", kind: "input", title: "Name?" } });
		const typing = view.element.querySelector("input");
		assert.ok(typing);
		typing.focus();
		view.add({ request: { id: "c1", kind: "confirm", title: "Proceed?" } });
		assert.equal(document.activeElement, typing);
	});

	it("leaves focus on a text field outside the cards while the user is typing there", () => {
		const outside = document.createElement("textarea");
		document.body.append(outside);
		outside.focus();
		view.add({ request: { id: "c1", kind: "confirm", title: "Proceed?" } });
		assert.equal(document.activeElement, outside);
	});

	it("returns focus to the composer when an answer is sent", () => {
		view.add({ request: { id: "c1", kind: "confirm", title: "Proceed?" } });
		click([...view.element.querySelectorAll("button")].find(button => button.textContent === "Approve"));
		assert.equal(composerFocusCalls, 1);
		assert.deepEqual(posted, [{ type: "respond", id: "c1", response: { kind: "confirmed", confirmed: true } }]);
	});

	it("returns focus to the composer when the question the user is on goes away", () => {
		view.add({ request: { id: "c1", kind: "confirm", title: "Proceed?" } });
		assert.equal(document.activeElement?.textContent, "Approve");
		view.remove("c1");
		assert.equal(composerFocusCalls, 1);
	});

	it("leaves focus alone when a question the user is not on goes away", () => {
		composerFocused = true;
		view.add({ request: { id: "c1", kind: "confirm", title: "Proceed?" } });
		view.remove("c1");
		assert.equal(composerFocusCalls, 0);
	});

	it("submits a question's free-text answer on Enter", () => {
		view.add({ request: { id: "q1", kind: "ask", questions: [{ id: "color", question: "Which color?", options: [{ label: "red" }] }] } });
		const other = view.element.querySelector<HTMLInputElement>('input[placeholder="Other…"]');
		assert.ok(other);
		other.value = "teal";
		other.dispatchEvent(event("keydown", { key: "Enter", isComposing: false }));
		assert.deepEqual(posted, [{ type: "respond", id: "q1", response: { kind: "answers", answers: [{ id: "color", selectedOptions: [], customInput: "teal" }] } }]);
	});

	it("cancels a question it cannot show, so OMP does not wait for its timeout", () => {
		const malformed = { request: { id: "q1", kind: "ask", questions: [{ id: "color", question: "Which color?" }] } } as unknown as PendingInteraction;
		assert.throws(() => view.add(malformed));
		assert.deepEqual(posted, [{ type: "respond", id: "q1", response: { kind: "cancelled" } }]);
		assert.equal(view.size, 0);
	});

	it("cancels the question on Escape", () => {
		view.add({ request: { id: "i1", kind: "input", title: "Name?" } });
		view.element.querySelector("input")?.dispatchEvent(event("keydown", { key: "Escape", isComposing: false }));
		assert.deepEqual(posted, [{ type: "respond", id: "i1", response: { kind: "cancelled" } }]);
	});

	it("keeps what the user entered when the same question is shown again", () => {
		const ask: PendingInteraction = {
			request: { id: "q1", kind: "ask", questions: [{ id: "color", question: "Which color?", multi: true, options: [{ label: "red" }, { label: "blue" }] }] },
		};
		view.add(ask);
		const [, blue] = view.element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		blue.checked = true;
		const typed = view.element.querySelector<HTMLInputElement>('input[type="text"]');
		assert.ok(typed);
		typed.value = "teal";
		view.add(ask);
		const shown = [...view.element.querySelectorAll<HTMLInputElement>("input")];
		assert.deepEqual(
			shown.map(input => (input.type === "text" ? input.value : input.checked === true)),
			[false, true, "teal"],
		);
		assert.equal(view.element.querySelectorAll(".interaction").length, 1);
	});

	it("keeps focus on the control the user was on when the same question is shown again", () => {
		const pending: PendingInteraction = { request: { id: "i1", kind: "input", title: "Name?" } };
		view.add(pending);
		const cancel = () => [...view.element.querySelectorAll("button")].find(button => button.textContent === "Cancel");
		const before = cancel();
		before?.focus();
		view.add(pending);
		assert.ok(cancel() !== before);
		assert.ok(cancel() && document.activeElement === cancel());
	});

	it("drops the countdown when the question is shown again without a timeout", () => {
		view.add({ request: { id: "i1", kind: "input", title: "Name?" }, expiresAt: Date.now() + 30_000 });
		view.add({ request: { id: "i1", kind: "input", title: "Name?" } });
		assert.equal(view.element.querySelector(".countdown")?.textContent, "");
		assert.equal(liveIntervals(), 0);
	});
});
