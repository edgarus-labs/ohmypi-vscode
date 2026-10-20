import * as assert from "node:assert/strict";
import type { TranscriptItem } from "../../../src/omp/api";
import { emptySessionView } from "../../../src/shared/session";
import { startWebviewApp, type WebviewApp } from "../../../src/webview/app";
import { copied, event, type FakeVsCodeApi, fakeVsCodeApi, type ResetMessage, settle, useDom } from "./webviewDom";

function reset(items: TranscriptItem[]): ResetMessage {
	return {
		type: "reset",
		items,
		session: emptySessionView(),
		connection: { state: "ready" },
		interactions: [],
		includeEditorContext: true,
		testHooks: false,
		statuses: [],
		dismissedTodos: [],
	};
}

describe("webview file links", () => {
	useDom();
	let api: FakeVsCodeApi;
	let root: HTMLElement;
	let app: WebviewApp;

	beforeEach(() => {
		api = fakeVsCodeApi();
		root = document.createElement("div");
		document.body.append(root);
		app = startWebviewApp(api, root);
	});

	function dispatch(target: Element | null, type: string, extra: Record<string, unknown> = {}): Event {
		if (!target) throw new Error(`${type} target not found`);
		const sent = event(type, extra);
		target.dispatchEvent(sent);
		return sent;
	}

	it("opens a file named in inline code of a reply when clicked, without navigating", () => {
		app.handle(reset([{ kind: "assistant", id: "a1", text: "see `src/a.ts:12`", thinking: "", streaming: false }]));
		const sent = dispatch(root.querySelector(".md a.file-link code"), "click");
		assert.deepEqual(api.postedOf("openFile"), [{ type: "openFile", path: "src/a.ts", line: 12 }]);
		assert.equal(sent.defaultPrevented, true);
	});

	it("opens a markdown link to a file with Enter, once", () => {
		app.handle(reset([{ kind: "assistant", id: "a1", text: "see [the entry point](extension.ts)", thinking: "", streaming: false }]));
		const link = root.querySelector(".md a.file-link");
		const sent = dispatch(link, "keydown", { key: "Enter" });
		assert.equal(link?.textContent, "the entry point");
		assert.deepEqual(api.postedOf("openFile"), [{ type: "openFile", path: "extension.ts" }]);
		assert.equal(sent.defaultPrevented, true);
	});

	it("ignores keys other than Enter on a file link", () => {
		app.handle(reset([{ kind: "assistant", id: "a1", text: "`extension.ts`", thinking: "", streaming: false }]));
		dispatch(root.querySelector(".md a.file-link"), "keydown", { key: "a" });
		assert.deepEqual(api.postedOf("openFile"), []);
	});

	it("asks the host to open a web link of a reply, by click or Enter, without navigating", () => {
		app.handle(reset([{ kind: "assistant", id: "a1", text: "see [docs](https://x.dev/a?b=1&c=2)", thinking: "", streaming: false }]));
		const link = root.querySelector(".md a.web-link");
		const sent = dispatch(link, "click");
		dispatch(link, "keydown", { key: "Enter" });
		assert.deepEqual(api.postedOf("openExternal"), [
			{ type: "openExternal", url: "https://x.dev/a?b=1&c=2" },
			{ type: "openExternal", url: "https://x.dev/a?b=1&c=2" },
		]);
		assert.equal(sent.defaultPrevented, true);
	});

	it("copies a reply's code block with its Copy button", async () => {
		app.handle(reset([{ kind: "assistant", id: "a1", text: "```ts\nconst a = 1 < 2;\n```", thinking: "", streaming: false }]));
		dispatch(root.querySelector(".md .code-copy"), "click");
		await settle();
		assert.deepEqual(copied, ["const a = 1 < 2;"]);
	});

	it("opens the path in a file tool's header without opening the row", () => {
		const read: TranscriptItem = {
			kind: "tool",
			id: "t1",
			name: "read",
			args: { path: "d:/dev/x/extension.ts:50-60" },
			status: "done",
			startedAt: 0,
			endedAt: 1,
			result: { text: "body", isError: false },
		};
		app.handle(reset([read]));
		const link = root.querySelector(".tool-head .tool-primary a.file-link");
		assert.equal(link?.textContent, "d:/dev/x/extension.ts:50-60");
		const sent = dispatch(link, "click");
		assert.deepEqual(api.postedOf("openFile"), [{ type: "openFile", path: "d:/dev/x/extension.ts", line: 50 }]);
		assert.equal(sent.defaultPrevented, true);
		assert.equal(root.querySelector(".tool")?.classList.contains("expanded"), false);
	});

	it("keeps a non-file tool's collapsed row as plain text", () => {
		const bash: TranscriptItem = { kind: "tool", id: "t2", name: "bash", args: { command: "cat src/a.ts" }, status: "done", startedAt: 0, endedAt: 1 };
		app.handle(reset([bash]));
		assert.equal(root.querySelector(".tool-primary a"), null);
		assert.equal(root.querySelector(".tool-primary")?.textContent, "cat src/a.ts");
	});
});
