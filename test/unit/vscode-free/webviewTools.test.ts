import * as assert from "node:assert/strict";
import { OpenStateStore, type RenderContext } from "../../../src/webview/context";
import { collapsible } from "../../../src/webview/dom";
import type { WebviewMessage } from "../../../src/webview/protocol";
import { renderTool, type ToolItem } from "../../../src/webview/tools";
import { click, copied, event, settle, useDom } from "./webviewDom";

function tool(overrides: Partial<ToolItem> & Pick<ToolItem, "name">): ToolItem {
	return { kind: "tool", id: "t1", args: {}, status: "done", startedAt: 0, endedAt: 1, ...overrides };
}

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

/** The button labeled `label` inside `root`. */
function button(root: Element, label: string): HTMLElement | undefined {
	return [...root.querySelectorAll<HTMLElement>("button")].find(candidate => candidate.textContent === label);
}

function labels(root: Element): string[] {
	return [...root.querySelectorAll("button")].map(candidate => candidate.textContent ?? "");
}

/** Renders `item` into the document, as the transcript does. */
function mount(item: ToolItem, ctx: RenderContext): HTMLElement {
	const el = renderTool(item, ctx);
	document.body.append(el);
	return el;
}

describe("tool rows", () => {
	useDom();
	let ctx: RenderContext;
	let posted: WebviewMessage[];

	beforeEach(() => {
		posted = [];
		ctx = Object.assign(new OpenStateStore(), { post: (message: WebviewMessage) => posted.push(message) });
	});

	describe("preview and expansion", () => {
		const bash = tool({ name: "bash", args: { command: "make" }, result: { text: numbered(8), isError: false } });

		it("always shows a dim preview of the first 5 lines under the header", () => {
			const el = mount(bash, ctx);
			assert.equal(el.querySelector(".tool-part .code-text")?.textContent, numbered(5));
			assert.deepEqual(labels(el), ["show more (8 lines)"]);
			assert.equal(el.classList.contains("expanded"), false);
		});

		it("cuts a preview of long lines to 2000 characters", () => {
			const el = mount(tool({ name: "bash", args: { command: "x" }, result: { text: "y".repeat(2500), isError: false } }), ctx);
			assert.equal(el.querySelector(".code-text")?.textContent?.length, 2000);
			assert.deepEqual(labels(el), ["show more (1 line)"]);
		});

		it("opens the whole row on show more and closes it on collapse, remembering the choice per call", () => {
			const el = mount(bash, ctx);
			click(button(el, "show more (8 lines)"));
			assert.equal(el.classList.contains("expanded"), true);
			assert.equal(el.querySelector(".code-text")?.textContent, numbered(8));
			assert.ok(el.querySelector(".code-view.expanded"), "the open text sits in its own scroller");
			assert.deepEqual(labels(el), ["collapse"]);
			assert.equal(renderTool(bash, ctx).querySelector(".code-text")?.textContent, numbered(8));
			click(button(el, "collapse"));
			assert.equal(el.querySelector(".code-text")?.textContent, numbered(5));
			assert.equal(renderTool(bash, ctx).classList.contains("expanded"), false);
		});

		it("offers Copy all when the open row still withholds text", async () => {
			const text = numbered(2500);
			const el = mount(tool({ name: "bash", args: { command: "x" }, result: { text, isError: false } }), ctx);
			click(button(el, "show more (2500 lines)"));
			assert.equal(el.querySelector(".code-text")?.textContent, numbered(2000));
			click(button(el, "Copy all 2500 lines"));
			await settle();
			assert.deepEqual(copied, [text]);
		});

		it("shows a finished read as its header and show more only, opening to its listing", () => {
			const read = tool({ name: "read", args: { path: "src/a.ts" }, result: { text: "9:const a = 1;\n10:const b = 2;\n", isError: false } });
			const el = mount(read, ctx);
			assert.equal(el.querySelector(".tool-body"), null);
			assert.deepEqual(labels(el), ["show more (2 lines)"]);
			click(button(el, "show more (2 lines)"));
			assert.ok(el.querySelector(".tool-body .code-view"));
			assert.deepEqual(labels(el), ["collapse"]);
		});

		it("keeps showing a failed call's first error line", () => {
			const el = mount(tool({ name: "read", args: { path: "a.ts" }, status: "error", result: { text: "ENOENT: a.ts\nstack", isError: true } }), ctx);
			assert.equal(el.querySelector(".tool-error")?.textContent, "ENOENT: a.ts");
			assert.ok(el.querySelector(".tool-body"), "a failed read shows its output");
		});
	});

	describe("input and output", () => {
		it("labels input and result IN and OUT and shows arguments as name: value lines", () => {
			const el = mount(tool({ name: "web_search", args: { query: "vscode", limit: 3 }, result: { text: "found", isError: false } }), ctx);
			assert.deepEqual(
				[...el.querySelectorAll(".tool-label")].map(label => label.textContent),
				["IN", "OUT"],
			);
			assert.equal(el.querySelector(".tool-part .code-text")?.textContent, "query: vscode\nlimit: 3");
		});

		it("copies the indented JSON of the arguments when all of them are selected", () => {
			const args = { query: "vscode", limit: 3 };
			const el = mount(tool({ name: "web_search", args, result: { text: "found", isError: false } }), ctx);
			const input = el.querySelector(".tool-part .code-text");
			Object.defineProperty(document, "getSelection", { configurable: true, value: () => ({ toString: () => input?.textContent ?? "" }) });
			const data: Record<string, string> = {};
			const copy = event("copy", { clipboardData: { setData: (type: string, value: string) => (data[type] = value) } });
			input?.dispatchEvent(copy);
			assert.deepEqual(data, { "text/plain": JSON.stringify(args, null, 2) });
			assert.equal(copy.defaultPrevented, true);
		});

		it("shows a described shell call's command and other arguments as input and its output without OMP's trailer", () => {
			const el = mount(
				tool({ name: "bash", args: { command: "npm test", i: "Running tests", timeout: 60 }, result: { text: "ok\n\nWall time: 1s\n", isError: false } }),
				ctx,
			);
			const texts = [...el.querySelectorAll(".code-text")].map(code => code.textContent);
			assert.deepEqual(texts, ["npm test", "timeout: 60", "ok"]);
			assert.equal(el.querySelector(".tool-primary")?.textContent, "Running tests");
		});

		it("splits a read listing into an unselectable line-number gutter and code", () => {
			ctx.setOpen("t1:open", true);
			const el = mount(tool({ name: "read", args: { path: "a.ts" }, result: { text: "[a.ts#1F]\n9:const a = 1;\n10:b();", isError: false } }), ctx);
			const gutter = el.querySelector(".code-gutter");
			assert.equal(gutter?.textContent, " 9\n10");
			assert.equal(gutter?.getAttribute("aria-hidden"), "true");
			assert.equal(el.querySelector(".code-text")?.textContent, "const a = 1;\nb();");
			assert.ok(el.querySelector(".code-view.numbered"), "numbered code does not wrap");
			assert.ok(el.querySelector(".code-text .tok-keyword"), "the code is colored by the file's language");
		});

		it("marks a search's matches in its result", () => {
			const el = mount(tool({ name: "grep", args: { pattern: "foo", case: false }, result: { text: "a.ts:1: Foo bar\na.ts:2: no", isError: false } }), ctx);
			assert.deepEqual(
				[...el.querySelectorAll(".tok-mark")].map(mark => mark.textContent),
				["Foo"],
			);
		});

		it("renders a Markdown-looking MCP result as Markdown", () => {
			const el = mount(tool({ name: "mcp__docs__fetch", result: { text: "# Guide\n\nUse **it**.", isError: false } }), ctx);
			assert.equal(el.querySelector(".tool-part .md h3")?.textContent, "Guide");
		});
	});

	describe("diffs", () => {
		const diffLines = (count: number) => ["@@ -1 +1 @@", "-const total = 1;", "+const sum = 1;", ...Array.from({ length: count - 3 }, (_, index) => ` ctx ${index}`)].join("\n");

		it("shows 20 tinted lines with the changed words marked, then show more", () => {
			const el = mount(tool({ name: "edit", args: { path: "a.ts" }, result: { text: "ok", isError: false, details: { diff: diffLines(30) } } }), ctx);
			assert.equal(el.querySelectorAll(".diff-line").length, 20);
			assert.equal(el.querySelector(".d-add .d-sign")?.textContent, "+");
			assert.deepEqual(
				[...el.querySelectorAll(".d-word")].map(word => word.textContent),
				["total", "sum"],
			);
			click(button(el, "show more (30 lines)"));
			assert.equal(el.querySelectorAll(".diff-line").length, 30);
		});

		it("offers Copy all past 2000 diff lines", async () => {
			const diff = diffLines(2100);
			const el = mount(tool({ name: "edit", args: { path: "a.ts" }, result: { text: "ok", isError: false, details: { diff } } }), ctx);
			click(button(el, "show more (2100 lines)"));
			assert.equal(el.querySelectorAll(".diff-line").length, 2000);
			assert.ok(el.textContent?.includes("Showing the first 2000 of 2100 lines."));
			click(button(el, "Copy all 2100 diff lines"));
			await settle();
			assert.deepEqual(copied, [diff]);
		});

		it("renders output that looks like a diff as a diff", () => {
			const el = mount(tool({ name: "bash", args: { command: "git diff" }, result: { text: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b", isError: false } }), ctx);
			assert.equal(el.querySelectorAll(".diff-line").length, 4);
		});

		it("posts the file of a per-file Diff link", () => {
			const el = mount(tool({ name: "edit", args: { edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }, result: { text: "ok", isError: false } }), {
				...ctx,
				isOpen: key => ctx.isOpen(key),
				setOpen: (key, open) => ctx.setOpen(key, open),
				cwd: "/w",
			});
			click(button(el, "Diff src/b.ts"));
			assert.deepEqual(posted, [{ type: "openDiff", toolCallId: "t1", path: "src/b.ts" }]);
		});
	});

	it("shows a call still running in the background with a clock", () => {
		const el = mount(tool({ name: "bash", args: { command: "serve" }, result: { text: "started", isError: false, details: { async: { state: "running" } } } }), ctx);
		assert.ok(el.classList.contains("status-background"));
		const status = el.querySelector(".tool-status");
		assert.equal(status?.getAttribute("title"), "started in the background, still running");
		assert.equal(status?.getAttribute("aria-label"), "running in the background");
		assert.ok(status?.querySelector(".icon-clock"));
	});

	it("says so when the specialized view of a tool fails", () => {
		const details = new Proxy(
			{},
			{
				get() {
					throw new Error("bad details");
				},
			},
		);
		const el = renderTool(tool({ name: "edit", args: { path: "a.ts" }, result: { text: "ok", isError: false, details } }), ctx);
		assert.equal(el.querySelector(".tool-fallback")?.textContent, "Specialized view failed (bad details); showing raw arguments and output.");
		assert.ok(el.querySelector(".tool-body .code-text"), "the generic body is still shown");
	});

	it("shows an error in a section whose body cannot be built", () => {
		ctx.setOpen("k", true);
		const details = collapsible(ctx, "k", ["section"], () => {
			throw new Error("no body");
		});
		assert.equal(details.querySelector(".notice.level-error")?.textContent, "Could not show this section: no body");
	});
});
