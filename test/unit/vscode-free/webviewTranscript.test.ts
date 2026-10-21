import * as assert from "node:assert/strict";
import type { TranscriptItem } from "../../../src/omp/api";
import { OpenStateStore, type RenderContext } from "../../../src/webview/context";
import { TranscriptView } from "../../../src/webview/transcript";
import { click, event, useDom } from "./webviewDom";

type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;
type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

function assistant(overrides: Partial<AssistantItem> = {}): AssistantItem {
	return { kind: "assistant", id: "a1", text: "", thinking: "", streaming: true, ...overrides };
}

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
	return { kind: "tool", id: "t1", name: "bash", args: { command: "ls" }, status: "running", startedAt: 1_000, ...overrides };
}

describe("TranscriptView", () => {
	useDom();
	let ctx: RenderContext;
	let announced: string[];
	let view: TranscriptView;

	beforeEach(() => {
		ctx = Object.assign(new OpenStateStore(), { post: () => {} });
		announced = [];
		view = new TranscriptView(ctx, text => announced.push(text));
		document.body.append(view.element);
	});

	it("patches a streaming reply in place instead of replacing its node", () => {
		view.upsert(assistant({ text: "Hel" }));
		const node = view.element.firstElementChild;
		view.upsert(assistant({ text: "Hello **world**" }));
		assert.equal(view.element.childElementCount, 1);
		assert.ok(view.element.firstElementChild === node, "the reply node was replaced");
		assert.equal(node?.querySelector(".md")?.innerHTML, "<p>Hello <strong>world</strong></p>");
	});

	it("keeps the thinking section node while the reply streams", () => {
		ctx.setOpen("a1:thinking", true);
		view.upsert(assistant({ thinking: "plan" }));
		const thinking = view.element.querySelector("details");
		view.upsert(assistant({ thinking: "plan\nmore", text: "Hi" }));
		assert.ok(view.element.querySelector("details") === thinking, "the thinking section was replaced");
		assert.equal(thinking?.querySelector(".thinking")?.textContent, "plan\nmore");
		assert.equal(thinking?.querySelector("summary")?.textContent, "Thinking · 2 lines");
	});

	it("keeps the conversation out of the live region and announces a finished reply once", () => {
		assert.equal(view.element.getAttribute("aria-live"), "off");
		view.upsert(assistant({ text: "Hel" }));
		view.upsert(assistant({ text: "Hello" }));
		assert.deepEqual(announced, []);
		view.upsert(assistant({ text: "Hello", streaming: false }));
		view.upsert(assistant({ text: "Hello", streaming: false, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }));
		assert.deepEqual(announced, ["Hello"]);
	});

	it("does not announce the history a reset restores", () => {
		view.reset([assistant({ text: "old reply", streaming: false })]);
		assert.deepEqual(announced, []);
	});

	it("announces notices", () => {
		view.notice("error", "Prompt not sent");
		assert.deepEqual(announced, ["Prompt not sent"]);
	});

	it("marks a streaming reply busy until it finishes", () => {
		view.upsert(assistant({ text: "Hel" }));
		const node = view.element.firstElementChild;
		assert.equal(node?.getAttribute("aria-busy"), "true");
		view.upsert(assistant({ text: "Hello", streaming: false, model: "m1" }));
		assert.equal(node?.hasAttribute("aria-busy"), false);
		assert.equal(node?.classList.contains("streaming"), false);
		assert.equal(node?.querySelector(".msg-meta")?.textContent, "m1");
	});

	it("patches a tool row in place so its header node survives updates", () => {
		view.upsert(tool());
		const node = view.element.firstElementChild;
		const head = node?.querySelector(".tool-head");
		view.upsert(tool({ status: "done", endedAt: 3_500, result: { text: "a\nb", isError: false } }));
		assert.ok(view.element.firstElementChild === node, "the tool node was replaced");
		assert.ok(node?.querySelector(".tool-head") === head, "the tool header was replaced");
		assert.ok(node?.classList.contains("status-done"));
		assert.equal(node?.querySelector(".tool-detail")?.textContent, "2.5s");
	});

	it("opens a patched tool row in place and counts only closed rows as collapsed", () => {
		const lines = Array.from({ length: 8 }, (_, index) => `line ${index}`).join("\n");
		view.upsert(tool());
		view.upsert(tool({ id: "t2" }));
		view.upsert(tool({ status: "done", endedAt: 3_500, result: { text: lines, isError: false } }));
		assert.equal(view.collapsedTools(), 2);
		const node = view.element.firstElementChild;
		click([...(node?.querySelectorAll("button") ?? [])].find(button => button.textContent === "show more (8 lines)"));
		assert.ok(node?.classList.contains("expanded"), "the row in the transcript opened");
		assert.ok(node?.classList.contains("item"), "the row keeps its transcript classes");
		assert.equal(node?.querySelector(".code-text")?.textContent, lines);
		assert.equal(view.collapsedTools(), 1);
	});

	it("shows a stored call without a result neutrally, not as failed", () => {
		view.upsert(tool({ status: "unresolved" }));
		const node = view.element.firstElementChild;
		assert.ok(node?.classList.contains("status-unresolved"));
		assert.equal(node?.classList.contains("status-error"), false);
		assert.equal(node?.querySelector(".tool-status")?.getAttribute("aria-label"), "no result");
		assert.ok(node?.querySelector(".tool-error") === null, "an unresolved call shows an error line");
	});

	it("lets keyboard users expand a truncated notice", () => {
		view.notice("warning", "a very long notice");
		const notice = view.element.querySelector<HTMLElement>(".item.notice");
		assert.equal(notice?.getAttribute("tabindex"), "0");
		assert.equal(notice?.getAttribute("role"), "button");
		assert.equal(notice?.getAttribute("aria-expanded"), "false");
		notice?.dispatchEvent(event("keydown", { key: "Enter" }));
		assert.equal(notice?.getAttribute("aria-expanded"), "true");
		assert.ok(notice?.classList.contains("expanded"));
		notice?.dispatchEvent(event("keydown", { key: " " }));
		assert.equal(notice?.getAttribute("aria-expanded"), "false");
	});

	it("labels the user's message as a group", () => {
		view.upsert({ kind: "user", id: "u1", text: "hi" });
		const user = view.element.querySelector(".item.user");
		assert.equal(user?.getAttribute("role"), "group");
		assert.equal(user?.getAttribute("aria-label"), "You");
	});

	it("dims a pending user message and shows it confirmed in the same place", () => {
		view.upsert({ kind: "user", id: "u1", text: "hi", pending: true });
		view.upsert(assistant({ id: "a2", text: "later" }));
		assert.equal(view.element.querySelector(".item.user")?.classList.contains("pending"), true);
		view.upsert({ kind: "user", id: "u1", text: "hi" });
		const user = view.element.firstElementChild;
		assert.equal(user?.classList.contains("user"), true);
		assert.equal(user?.classList.contains("pending"), false);
		assert.equal(view.element.querySelectorAll(".item.user").length, 1);
	});

	it("shows a typed slash command with the text OMP expanded it to collapsed", () => {
		view.upsert({ kind: "user", id: "u1", text: "/review src", expandedText: "Review the code in src." });
		const user = view.element.querySelector(".item.user");
		assert.equal(user?.querySelector(".text")?.textContent, "/review src");
		const details = user?.querySelector("details");
		assert.equal(details?.open, false);
		assert.equal(details?.querySelector("summary")?.textContent, "expanded command");
		assert.equal(details?.querySelector("pre")?.textContent ?? "", "");
		if (!details) assert.fail("no expanded command section");
		details.open = true;
		details.dispatchEvent(event("toggle"));
		assert.equal(user?.querySelector("details pre")?.textContent, "Review the code in src.");
	});

	it("names a reply's model on its meta line and leaves its tokens and cost to the tooltip and the turn summary", () => {
		view.upsert(assistant({ text: "done", streaming: false, model: "m1", usage: { input: 1_200, output: 30, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 } }));
		const meta = view.element.querySelector(".msg-meta");
		assert.equal(meta?.textContent, "m1");
		assert.equal(meta?.getAttribute("title"), "1.2k in · 30 out · $0.0100");
	});

	it("keeps a trailing row after every item it shows, also after a reset", () => {
		const tail = document.createElement("div");
		const withTail = new TranscriptView(ctx, () => {}, tail);
		withTail.upsert({ kind: "user", id: "u1", text: "hi" });
		withTail.notice("info", "note");
		assert.ok(withTail.element.lastElementChild === tail);
		withTail.reset([{ kind: "user", id: "u2", text: "again" }]);
		assert.deepEqual(Array.from(withTail.element.children, child => child.getAttribute("data-id")), ["u2", "local-1", null]);
		assert.ok(withTail.element.lastElementChild === tail);
	});

	it("is empty after a reset to no items", () => {
		view.upsert({ kind: "user", id: "u1", text: "hi" });
		assert.equal(view.isEmpty, false);
		view.reset([]);
		assert.equal(view.isEmpty, true);
	});

	it("keeps the webview's own notices across a reset, after the restored items", () => {
		const ids = () => Array.from(view.element.children, child => child.getAttribute("data-id"));
		view.upsert({ kind: "user", id: "u1", text: "hi" });
		view.notice("warning", "attach the images again");
		view.reset([
			{ kind: "user", id: "u2", text: "again" },
			{ kind: "notice", id: "h1", level: "info", text: "compacted" },
		]);
		assert.deepEqual(ids(), ["u2", "h1", "local-1"]);
		view.reset([]);
		assert.deepEqual(ids(), ["local-1"]);
		assert.equal(view.hasConversation, false);
		assert.deepEqual(announced, ["attach the images again"]);
	});
});
