import * as assert from "node:assert/strict";
import type { TranscriptItem } from "../../../src/omp/api";
import { OpenStateStore, type RenderContext } from "../../../src/webview/context";
import { TranscriptView } from "../../../src/webview/transcript";
import { click, copied, settle, useDom } from "./webviewDom";

type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;

function assistant(overrides: Partial<AssistantItem> = {}): AssistantItem {
	return { kind: "assistant", id: "a1", text: "", thinking: "", streaming: true, ...overrides };
}

describe("transcript messages", () => {
	useDom();
	let view: TranscriptView;

	beforeEach(() => {
		const ctx: RenderContext = Object.assign(new OpenStateStore(), { post: () => {} });
		view = new TranscriptView(ctx, () => {});
		document.body.append(view.element);
	});

	it("copies the whole text of a user message", async () => {
		const text = "fix the bug\n\n@src/a.ts";
		view.upsert({ kind: "user", id: "u1", text });
		click(view.element.querySelector(".item.user .copy-button"));
		await settle();
		assert.deepEqual(copied, [text]);
	});

	it("copies a finished reply's markdown source and offers no copy while it streams", async () => {
		view.upsert(assistant({ text: "Hello **wor" }));
		assert.equal(view.element.querySelector(".item.assistant .copy-button"), null);
		view.upsert(assistant({ text: "Hello **world**", streaming: false, model: "m1" }));
		click(view.element.querySelector(".item.assistant .copy-button"));
		await settle();
		assert.deepEqual(copied, ["Hello **world**"]);
	});

	it("shows on the copy button why copying failed", async () => {
		Object.defineProperty(globalThis, "navigator", {
			value: { clipboard: { writeText: () => Promise.reject(new Error("denied")) } },
			configurable: true,
			writable: true,
		});
		view.upsert({ kind: "user", id: "u1", text: "hi" });
		const button = view.element.querySelector(".copy-button");
		click(button);
		await settle();
		assert.equal(button?.getAttribute("title"), "Copy failed: denied");
		assert.equal(button?.getAttribute("data-copy-state"), "failed");
	});

	it("shows a slash-command prompt as a command beside the slash mark", () => {
		view.upsert({ kind: "user", id: "u1", text: "/review src" });
		view.upsert({ kind: "user", id: "u2", text: "review src" });
		const [command, prose] = view.element.querySelectorAll(".item.user");
		assert.equal(command.querySelector(".command-prompt code.text")?.textContent, "/review src");
		assert.ok(command.querySelector(".command-prompt svg.icon-slashCommand"), "no slash mark");
		assert.equal(prose.querySelector(".command-prompt"), null);
		assert.equal(prose.querySelector(".text")?.textContent, "review src");
	});

	it("titles the turn summary with the turn's token counts", () => {
		view.upsert({ kind: "turn_summary", id: "s1", status: "completed", usage: { input: 1_200, output: 30, cacheRead: 15_000, cacheWrite: 0 } });
		assert.equal(
			view.element.querySelector(".turn-summary")?.getAttribute("title"),
			"1,200 input · 15,000 cache read · 0 cache write · 30 output tokens",
		);
	});
});
