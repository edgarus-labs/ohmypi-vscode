import * as assert from "node:assert/strict";
import type { InteractionRequest, SessionView, TranscriptItem } from "../../../src/omp/api";
import { emptySessionView } from "../../../src/shared/session";
import { startWebviewApp, type WebviewApp } from "../../../src/webview/app";
import { click, event, type FakeVsCodeApi, fakeVsCodeApi, type ResetMessage, settle, useDom } from "./webviewDom";

function reset(overrides: Partial<ResetMessage> = {}): ResetMessage {
	return {
		type: "reset",
		items: [],
		session: emptySessionView(),
		connection: { state: "ready" },
		interactions: [],
		includeEditorContext: true,
		testHooks: false,
		statuses: [],
		dismissedTodos: [],
		...overrides,
	};
}

function session(overrides: Partial<SessionView>): SessionView {
	return { ...emptySessionView(), ...overrides };
}

const thinkingReply: TranscriptItem = { kind: "assistant", id: "h0", text: "answer", thinking: "plan", streaming: false };

describe("webview app", () => {
	useDom();
	let api: FakeVsCodeApi;
	let root: HTMLElement;
	let app: WebviewApp;

	function start(): WebviewApp {
		root = document.createElement("div");
		document.body.append(root);
		return startWebviewApp(api, root);
	}

	beforeEach(() => {
		api = fakeVsCodeApi();
		app = start();
	});

	it("posts render reports only when the host enables test hooks", async () => {
		app.handle(reset({ testHooks: false }));
		await settle();
		assert.equal(api.postedOf("rendered").length, 0);
		app.handle(reset({ testHooks: true }));
		await settle();
		assert.equal(api.postedOf("rendered").length, 1);
	});

	it("follows the host's editor-context default after a reload until the user toggles it", () => {
		app.handle(reset({ includeEditorContext: true }));
		root.remove();
		app = start();
		app.handle(reset({ includeEditorContext: true }));
		const toggle = root.querySelector("button.toggle.context");
		assert.equal(toggle?.getAttribute("aria-pressed"), "true");
		click(toggle);
		root.remove();
		app = start();
		app.handle(reset({ includeEditorContext: true }));
		assert.equal(root.querySelector("button.toggle.context")?.getAttribute("aria-pressed"), "false");
	});

	it("forgets expanded sections when another session is loaded", () => {
		app.handle(reset({ session: session({ sessionId: "a" }), items: [thinkingReply] }));
		const details = root.querySelector<HTMLDetailsElement>(".thinking-block");
		assert.ok(details);
		details.open = true;
		details.dispatchEvent(event("toggle"));
		app.handle(reset({ session: session({ sessionId: "a" }), items: [thinkingReply] }));
		assert.equal(root.querySelector<HTMLDetailsElement>(".thinking-block")?.open, true);
		app.handle(reset({ session: session({ sessionId: "b" }), items: [thinkingReply] }));
		assert.equal(root.querySelector<HTMLDetailsElement>(".thinking-block")?.open, false);
	});

	it("applies the rest of a reset when one part fails to render, and says what failed", async () => {
		const broken = { id: "s1", kind: "select", title: "Pick" } as unknown as InteractionRequest;
		app.handle(reset({ session: session({ sessionName: "Renamed" }), interactions: [{ request: broken }], testHooks: true }));
		await settle();
		assert.equal(root.querySelector(".session-title")?.textContent, "Renamed");
		assert.match(root.querySelector(".item.notice")?.textContent ?? "", /^Could not show the reset message: /);
		assert.equal(api.postedOf("rendered").length, 1);
		assert.deepEqual(api.postedOf("respond"), [{ type: "respond", id: "s1", response: { kind: "cancelled" } }]);
	});

	it("keeps an answer being typed when a reset shows the same question, and drops answered questions", () => {
		const pending = { request: { id: "i1", kind: "input", title: "Name?" } } as const;
		app.handle(reset({ interactions: [pending] }));
		const field = root.querySelector<HTMLInputElement>(".interaction input");
		assert.ok(field);
		field.value = "half typed";
		app.handle(reset({ interactions: [pending] }));
		assert.equal(root.querySelector<HTMLInputElement>(".interaction input")?.value, "half typed");
		app.handle(reset());
		assert.equal(root.querySelectorAll(".interaction").length, 0);
	});

	it("leaves focus in the composer when a question arrives while the user types there", () => {
		app.handle(reset());
		const input = root.querySelector<HTMLTextAreaElement>("textarea.input");
		input?.focus();
		app.handle({ type: "interaction", pending: { request: { id: "c1", kind: "confirm", title: "Proceed?" } } });
		assert.ok(input && document.activeElement === input);
	});

	it("focuses a question that arrives while the composer is not focused, and returns focus to the composer when it closes", () => {
		app.handle(reset());
		app.handle({ type: "interaction", pending: { request: { id: "c1", kind: "confirm", title: "Proceed?" } } });
		assert.equal(document.activeElement?.textContent, "Approve");
		app.handle({ type: "interactionClosed", id: "c1" });
		const input = root.querySelector("textarea.input");
		assert.ok(input && document.activeElement === input);
		app.handle({ type: "interaction", pending: { request: { id: "c2", kind: "confirm", title: "Again?" } } });
		[...root.querySelectorAll<HTMLButtonElement>(".interaction button")].find(button => button.textContent === "Deny")?.focus();
		assert.equal(document.activeElement?.textContent, "Deny");
		app.handle(reset());
		assert.ok(document.activeElement === input);
	});

	it("keeps file and text attachments across a reload, keeps the notice naming the images it lost, and numbers new pastes after the kept ones", async () => {
		app.handle(reset());
		app.handle({ type: "addAttachments", attachments: [{ id: "f1", kind: "file", path: "/w/a.ts", label: "a.ts" }] });
		const image = new File([new Uint8Array(4)], "shot.png", { type: "image/png" });
		const long = "line\n".repeat(20);
		const paste = (files: File[]) =>
			root.querySelector("textarea.input")?.dispatchEvent(event("paste", { clipboardData: { files, getData: (format: string) => (format === "text/plain" ? long : "") } }));
		paste([image]);
		await settle();
		root.remove();
		app = start();
		app.handle(reset());
		assert.deepEqual(
			[...root.querySelectorAll(".attachments .chip")].map(chip => chip.className),
			["chip file", "chip text"],
		);
		assert.match(root.querySelector(".item.notice")?.textContent ?? "", /shot\.png/);
		app.handle(reset({ items: [{ kind: "user", id: "u1", text: "hi" }] }));
		assert.deepEqual(
			[...root.querySelectorAll(".column > [data-id]")].map(item => item.getAttribute("data-id")),
			["u1", "local-1"],
		);
		paste([]);
		assert.deepEqual(
			api.state?.attachments?.map(attachment => attachment.label),
			["a.ts", "Pasted text 1", "Pasted text 2"],
		);
	});

	it("clears the composer only after the host accepted the prompt", () => {
		app.handle(reset());
		const input = root.querySelector("textarea.input") as HTMLTextAreaElement;
		input.value = "do it";
		input.dispatchEvent(event("input"));
		click(root.querySelector("button.send"));
		const [send] = api.postedOf("send");
		assert.equal(input.value, "do it");
		app.handle({ type: "sendResult", id: send.id, ok: false, error: "OMP is not running" });
		assert.equal(input.value, "do it");
		assert.match(root.querySelector(".item.notice")?.textContent ?? "", /Prompt not sent: OMP is not running/);
		click(root.querySelector("button.send"));
		const retry = api.postedOf("send")[1];
		app.handle({ type: "sendResult", id: retry.id, ok: true });
		assert.equal(input.value, "");
	});

	it("offers the session's slash commands in the composer", () => {
		const model = { name: "model", source: "builtin", aliases: [], subcommands: [] };
		app.handle(reset({ session: session({ commands: [model] }) }));
		const input = root.querySelector("textarea.input") as HTMLTextAreaElement;
		input.value = "/";
		input.dispatchEvent(event("input"));
		const names = () => Array.from(root.querySelectorAll('[role="option"] .slash-name'), option => option.textContent);
		assert.deepEqual(names(), ["/model"]);
		app.handle({ type: "session", session: session({ commands: [model, { ...model, name: "mcp" }] }) });
		assert.deepEqual(names(), ["/model", "/mcp"]);
	});
});
