import * as assert from "node:assert/strict";
import { Composer } from "../../../src/webview/composer";
import { h } from "../../../src/webview/dom";
import { PersistedState } from "../../../src/webview/state";
import { click, event, type FakeVsCodeApi, fakeVsCodeApi, settle, useDom } from "./webviewDom";

function pngFile(name: string, bytes = 4): File {
	return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

describe("Composer", () => {
	useDom();
	let api: FakeVsCodeApi;
	let notices: string[];
	let composer: Composer;

	beforeEach(() => {
		api = fakeVsCodeApi();
		notices = [];
		composer = new Composer(
			{
				post: message => api.postMessage(message),
				state: new PersistedState(api),
				notice: (level, text) => notices.push(`${level}: ${text}`),
				onSubmit: () => {},
				onAttachmentsChange: () => {},
			},
			{ modelPill: h("span"), fastButton: h("button"), usage: h("span") },
		);
		document.body.append(composer.element);
		composer.setStatus({ busy: false, unavailable: false });
	});

	function type(text: string): void {
		composer.input.value = text;
		composer.input.dispatchEvent(event("input"));
	}

	const sendButton = () => composer.element.querySelector("button.send");

	it("keeps the draft until the host confirms the prompt, then clears it", () => {
		type("hello");
		click(sendButton());
		const [send] = api.postedOf("send");
		assert.equal(send.text, "hello");
		assert.equal(composer.input.value, "hello");
		composer.handleSendResult({ id: send.id, ok: true });
		assert.equal(composer.input.value, "");
		assert.equal(api.state?.draft, "");
	});

	it("keeps the draft and attachments and shows the error when the prompt was not sent", () => {
		composer.addAttachments([{ id: "f1", kind: "file", path: "/w/a.ts", label: "a.ts" }]);
		type("hello");
		click(sendButton());
		const [send] = api.postedOf("send");
		composer.handleSendResult({ id: send.id, ok: false, error: "OMP is restarting" });
		assert.equal(composer.input.value, "hello");
		assert.deepEqual(composer.attachmentLabels, ["a.ts"]);
		assert.deepEqual(notices, ["error: Prompt not sent: OMP is restarting"]);
	});

	it("does not send the same draft twice while waiting for the host", () => {
		type("hello");
		click(sendButton());
		composer.input.dispatchEvent(event("keydown", { key: "Enter", shiftKey: false, isComposing: false }));
		assert.equal(api.postedOf("send").length, 1);
	});

	it("previews pasted images through object URLs and keeps existing chips", async () => {
		composer.input.dispatchEvent(event("paste", { clipboardData: { files: [pngFile("a.png")], getData: () => "" } }));
		await settle();
		const first = composer.element.querySelector(".chip.image");
		assert.match(first?.querySelector("img")?.getAttribute("src") ?? "", /^blob:/);
		composer.input.dispatchEvent(event("paste", { clipboardData: { files: [pngFile("b.png")], getData: () => "" } }));
		await settle();
		assert.deepEqual(composer.attachmentLabels, ["a.png", "b.png"]);
		assert.ok(composer.element.querySelector(".chip.image") === first, "the first image chip was replaced");
	});

	it("tells the user that dropped non-image files were not attached", () => {
		const drop = event("drop", { dataTransfer: { files: [new File(["x"], "notes.txt", { type: "text/plain" })], types: ["Files"] } });
		composer.element.dispatchEvent(drop);
		assert.equal(drop.defaultPrevented, true);
		assert.deepEqual(notices, ["warning: Only images can be dropped here; use + to attach other files (not attached: notes.txt)."]);
	});

	it("refuses images beyond the per-prompt limit", async () => {
		const files = Array.from({ length: 9 }, (_, index) => pngFile(`p${index}.png`));
		composer.input.dispatchEvent(event("paste", { clipboardData: { files, getData: () => "" } }));
		await settle();
		assert.equal(composer.attachmentLabels.length, 8);
		assert.deepEqual(notices, ["warning: Image p8.png was not attached: at most 8 images per prompt."]);
	});
});
