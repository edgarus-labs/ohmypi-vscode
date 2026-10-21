import * as assert from "node:assert/strict";
import type { ConnectionStatus, ModelView, SessionView } from "../../../src/omp/api";
import { emptySessionView } from "../../../src/shared/session";
import { startWebviewApp, type WebviewApp } from "../../../src/webview/app";
import { InteractionsView } from "../../../src/webview/interactions";
import { click, event, type FakeVsCodeApi, fakeVsCodeApi, focused, type ResetMessage, useDom } from "./webviewDom";

function reset(overrides: Partial<ResetMessage> = {}): ResetMessage {
	return {
		type: "reset",
		items: [],
		session: emptySessionView(),
		connection: { state: "ready" },
		interactions: [],
		includeEditorContext: false,
		testHooks: false,
		statuses: [],
		dismissedTodos: [],
		...overrides,
	};
}

function session(overrides: Partial<SessionView>): SessionView {
	return { ...emptySessionView(), ...overrides };
}

const model: ModelView = { provider: "anthropic", id: "claude-x", name: "Claude X", reasoning: false, thinkingEfforts: [], input: ["text"] };
const PAUSED = "tier-router: paused (model set manually: anthropic/claude-x)";
const todos = [{ name: "Build", tasks: [{ content: "write code", status: "in_progress" }] }];

describe("webview session chrome", () => {
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

	const input = () => root.querySelector("textarea.input") as HTMLTextAreaElement;
	const key = (target: Element, name: string, extra: Record<string, unknown> = {}) =>
		target.dispatchEvent(event("keydown", { key: name, shiftKey: false, altKey: false, isComposing: false, ...extra }));
	const type = (text: string) => {
		input().value = text;
		input().dispatchEvent(event("input"));
	};

	it("selects no effort when the session reports none or one the model does not offer", () => {
		const selected = () => [...(root.querySelector("select.thinking-select") as HTMLSelectElement).options].filter(option => option.selected).map(option => option.value);
		app.handle(reset({ session: session({ availableThinkingLevels: ["auto", "low", "high"], thinkingLevel: "high" }) }));
		assert.deepEqual(selected(), ["high"]);
		app.handle({ type: "session", session: session({ availableThinkingLevels: ["low", "high"], thinkingSelector: "auto" }) });
		assert.deepEqual(selected(), []);
		app.handle({ type: "session", session: session({ availableThinkingLevels: ["low", "high"], thinkingLevel: "low" }) });
		assert.deepEqual(selected(), ["low"]);
		app.handle({ type: "session", session: session({ availableThinkingLevels: ["low", "high"] }) });
		assert.deepEqual(selected(), []);
		assert.equal(root.querySelector(".item.notice"), null);
	});

	it("names the state in the indicator's tooltip, which stays when a narrow panel hides the word", () => {
		app.handle(reset({ connection: { state: "starting" } }));
		assert.equal(root.querySelector(".header .state")?.getAttribute("title"), "starting · connection: starting");
	});

	describe("composer keyboard", () => {
		it("stops the turn on Escape only while the session is not idle", () => {
			app.handle(reset());
			key(input(), "Escape");
			assert.equal(api.postedOf("abort").length, 0);
			app.handle({ type: "session", session: session({ phase: "yielded" }) });
			key(input(), "Escape");
			assert.equal(api.postedOf("abort").length, 1);
		});

		it("closes an open popup on Escape instead of stopping the turn", () => {
			const command = { name: "model", source: "builtin", aliases: [], subcommands: [] };
			app.handle(reset({ session: session({ phase: "running", commands: [command] }) }));
			type("/");
			key(input(), "Escape");
			assert.ok(root.querySelector(".slash-menu")?.classList.contains("hidden"));
			app.handle({ type: "toggleUsage" });
			key(input(), "Escape");
			assert.equal(root.querySelector(".usage-popup"), null);
			assert.equal(api.postedOf("abort").length, 0);
		});

		it("queues a follow-up on Alt+Enter while busy and sends normally when idle", () => {
			app.handle(reset({ session: session({ phase: "running" }) }));
			type("later");
			key(input(), "Enter", { altKey: true });
			const [followUp] = api.postedOf("send");
			assert.equal(followUp.mode, "followUp");
			app.handle({ type: "sendResult", id: followUp.id, ok: true });
			app.handle({ type: "session", session: session({ phase: "idle" }) });
			type("now");
			key(input(), "Enter", { altKey: true });
			assert.equal(api.postedOf("send")[1].mode, "auto");
		});
	});

	describe("welcome", () => {
		const line = () => root.querySelector(".empty-line")?.textContent;
		const recent = () => root.querySelector(".recent");

		it("follows the connection and offers to start OMP when it is not running", () => {
			app.handle(reset({ connection: { state: "starting" } }));
			assert.equal(line(), "Starting OMP…");
			assert.equal(root.querySelector(".empty .start-omp"), null);
			const connection = (status: ConnectionStatus) => app.handle({ type: "connection", connection: status });
			connection({ state: "failed", detail: "exit code 3" });
			assert.equal(line(), "OMP stopped: exit code 3");
			connection({ state: "failed" });
			assert.equal(line(), "OMP stopped.");
			connection({ state: "stopped" });
			assert.equal(line(), "OMP is not running. Send a message or start it now.");
			click(root.querySelector(".empty button.start-omp"));
			assert.deepEqual(api.postedOf("command"), [{ type: "command", command: "omp.restart" }]);
			connection({ state: "ready" });
			assert.equal(line(), "What should we build?");
			assert.equal(root.querySelector(".empty .start-omp"), null);
		});

		it("lists recent sessions only while OMP is ready", () => {
			app.handle(reset({ connection: { state: "stopped" } }));
			app.handle({ type: "recentSessions", sessions: [{ path: "/s/a.jsonl", title: "a", modified: 1 }], total: 1 });
			assert.ok(recent()?.classList.contains("hidden"));
			app.handle({ type: "connection", connection: { state: "ready" } });
			assert.ok(!recent()?.classList.contains("hidden"));
		});
	});

	describe("statuses", () => {
		const activity = () => root.querySelector(".header .activity") as HTMLElement;
		const resume = () => root.querySelector<HTMLButtonElement>(".header button.resume-tier");

		it("lists every status after compacting, with the tier router in its short form", () => {
			app.handle(
				reset({
					session: session({ isCompacting: true }),
					statuses: [
						{ key: "tier", text: "tier: standard (0.9/0.1/0)" },
						{ key: "lsp", text: "indexing" },
					],
				}),
			);
			assert.equal(activity().textContent, "compacting… · router auto · standard · indexing");
			assert.equal(activity().title, "compacting… · router auto · standard · indexing");
			app.handle({ type: "statuses", statuses: [] });
			app.handle({ type: "session", session: session({ isCompacting: false }) });
			assert.equal(activity().textContent, "");
		});

		it("offers resuming the paused tier router", () => {
			app.handle(reset({ statuses: [{ key: "tier", text: PAUSED }] }));
			click(resume());
			assert.deepEqual(api.postedOf("resumeTierRouter"), [{ type: "resumeTierRouter" }]);
			app.handle({ type: "statuses", statuses: [{ key: "tier", text: "tier-router: on (main on)" }] });
			assert.equal(resume(), null);
		});

		it("marks the composer model while the tier router chooses it", () => {
			const modelLabel = () => root.querySelector(".model-pill button.model")?.textContent;
			app.handle(reset({ session: session({ model }), statuses: [{ key: "tier", text: "tier-router: on (main on)" }] }));
			assert.equal(modelLabel(), "Claude X · tier auto");
			app.handle({ type: "statuses", statuses: [{ key: "tier", text: PAUSED }] });
			assert.equal(modelLabel(), "Claude X");
			app.handle({ type: "statuses", statuses: [{ key: "tier", text: "tier: premium (0/0/1)" }] });
			app.handle({ type: "session", session: session({}) });
			assert.equal(modelLabel(), "Select model");
		});
	});

	describe("todo dismissal", () => {
		const strip = () => root.querySelector(".todos") as HTMLElement;

		it("hides the closed todo list until its content changes, also after a reload", () => {
			app.handle(reset({ session: session({ todos }) }));
			click(strip().querySelector("button.todos-dismiss"));
			assert.equal(strip().childElementCount, 0);
			const [{ key }] = api.postedOf("dismissTodos");
			assert.match(key, /^todos:/);
			app.handle({ type: "session", session: session({ todos, isCompacting: true }) });
			assert.equal(strip().childElementCount, 0);
			const changed = [{ name: "Build", tasks: [{ content: "write code", status: "completed" }] }];
			app.handle({ type: "session", session: session({ todos: changed }) });
			assert.ok(strip().querySelector(".todo-summary"));

			root.remove();
			root = document.createElement("div");
			document.body.append(root);
			app = startWebviewApp(api, root);
			app.handle(reset({ session: session({ todos }), dismissedTodos: [key] }));
			assert.equal(strip().childElementCount, 0);
		});
	});

	describe("usage popup", () => {
		const popup = () => root.querySelector(".usage-popup") as HTMLElement | null;
		const body = () => popup()?.querySelector(".usage-popup-body")?.textContent;
		const refresh = () => popup()?.querySelector("button.usage-popup-refresh");

		it("loads on open and on Refresh, ignoring Refresh while loading", () => {
			app.handle(reset());
			click(root.querySelector(".header button.usage-button"));
			assert.equal(body(), "Loading usage…");
			click(refresh());
			const requests = api.postedOf("loadUsage");
			assert.equal(requests.length, 1);
			app.handle({ type: "usage", id: requests[0].id, error: "OMP printed no usage report" });
			assert.equal(body(), "Usage is unavailable: OMP printed no usage report");
			click(refresh());
			assert.equal(api.postedOf("loadUsage").length, 2);
			assert.equal(body(), "Loading usage…");
		});

		it("shows the limits of each provider that reports some", () => {
			app.handle(reset());
			app.handle({ type: "toggleUsage" });
			app.handle({ type: "usage", id: "stale", providers: [] });
			assert.equal(body(), "Loading usage…");
			const [{ id }] = api.postedOf("loadUsage");
			app.handle({
				type: "usage",
				id,
				providers: [
					{ provider: "Empty", limits: [] },
					{
						provider: "Anthropic",
						limits: [
							{ name: "Claude 5 Hour", account: "me@example.com", usedPercent: 4, inUse: true, resets: "in 4h" },
							{ name: "Claude 7 Day", account: "me@example.com", usedPercent: 85.25, inUse: false },
							{ name: "Opus", account: "me@example.com", usedPercent: 100, inUse: false },
						],
					},
				],
			});
			const headings = [...(popup()?.querySelectorAll(".usage-provider-name") ?? [])].map(heading => heading.textContent);
			assert.deepEqual(headings, ["Anthropic"]);
			const rows = [...(popup()?.querySelectorAll(".usage-limit") ?? [])] as HTMLElement[];
			assert.deepEqual(
				rows.map(row => [row.querySelector(".usage-limit-name")?.textContent, row.querySelector(".usage-limit-percent")?.textContent, row.querySelector(".usage-limit-resets")?.textContent]),
				[
					["Claude 5 Hour", "4%", "in 4h"],
					["Claude 7 Day", "85%", ""],
					["Opus", "100%", ""],
				],
			);
			assert.deepEqual(
				rows.map(row => row.className),
				["usage-limit in-use", "usage-limit warning", "usage-limit error"],
			);
			assert.equal(rows[0].title, "Claude 5 Hour\nme@example.com\n4% used\nResets in 4h\nUsed by this session");
			assert.equal(rows[1].title, "Claude 7 Day\nme@example.com\n85.25% used");
		});

		it("says when no provider reports usage limits", () => {
			app.handle(reset());
			app.handle({ type: "toggleUsage" });
			app.handle({ type: "usage", id: api.postedOf("loadUsage")[0].id, providers: [{ provider: "Empty", limits: [] }] });
			assert.equal(body(), "No provider reports usage limits.");
		});

		it("closes on Escape, on Close and on toggle, returning focus to the input", () => {
			app.handle(reset());
			app.handle({ type: "toggleUsage" });
			key(popup() as HTMLElement, "Escape");
			assert.equal(popup(), null);
			assert.ok(focused.at(-1) === input());
			app.handle({ type: "toggleUsage" });
			click(popup()?.querySelector("button.usage-popup-close"));
			assert.equal(popup(), null);
			app.handle({ type: "toggleUsage" });
			app.handle({ type: "toggleUsage" });
			assert.equal(popup(), null);
		});
	});
});

describe("ask options", () => {
	useDom();

	it("show their preview as a tooltip", () => {
		const view = new InteractionsView({ post: () => {}, announce: () => {}, composerHasFocus: () => true, focusComposer: () => {} });
		view.add({
			request: {
				id: "q1",
				kind: "ask",
				questions: [{ id: "q", question: "Which?", options: [{ label: "a", preview: "const a = 1;" }, { label: "b" }] }],
			},
		});
		const labels = [...view.element.querySelectorAll<HTMLElement>("label.ask-option")];
		assert.deepEqual(
			labels.map(label => label.title),
			["const a = 1;", ""],
		);
	});
});
