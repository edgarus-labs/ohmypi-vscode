import * as assert from "node:assert/strict";
import { InteractionsView } from "../../../src/webview/interactions";
import type { WebviewMessage } from "../../../src/webview/protocol";
import { click, event, focused, useDom } from "./webviewDom";

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

	it("returns focus to the composer when an answer is sent", () => {
		view.add({ request: { id: "c1", kind: "confirm", title: "Proceed?" } });
		click([...view.element.querySelectorAll("button")].find(button => button.textContent === "Approve"));
		assert.equal(composerFocusCalls, 1);
		assert.deepEqual(posted, [{ type: "respond", id: "c1", response: { kind: "confirmed", confirmed: true } }]);
	});

	it("submits a question's free-text answer on Enter", () => {
		view.add({ request: { id: "q1", kind: "ask", questions: [{ id: "color", question: "Which color?", options: [{ label: "red" }] }] } });
		const other = view.element.querySelector<HTMLInputElement>('input[placeholder="Other…"]');
		assert.ok(other);
		other.value = "teal";
		other.dispatchEvent(event("keydown", { key: "Enter", isComposing: false }));
		assert.deepEqual(posted, [{ type: "respond", id: "q1", response: { kind: "answers", answers: [{ id: "color", selectedOptions: [], customInput: "teal" }] } }]);
	});
});
