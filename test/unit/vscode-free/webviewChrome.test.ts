import * as assert from "node:assert/strict";
import type { SessionView } from "../../../src/omp/api";
import { emptySessionView } from "../../../src/shared/session";
import { OpenStateStore } from "../../../src/webview/context";
import { Header } from "../../../src/webview/header";
import { SessionControls } from "../../../src/webview/sessionControls";
import { SessionPanel } from "../../../src/webview/sessionPanel";
import { useDom } from "./webviewDom";

function session(overrides: Partial<SessionView> = {}): SessionView {
	return { ...emptySessionView(), ...overrides };
}

describe("webview session chrome", () => {
	useDom();

	it("keeps the ticking elapsed time out of the announced status", () => {
		const header = new Header(() => {}, () => {});
		header.render({ session: session({ phase: "running" }), connection: { state: "ready" }, pendingInteractions: 0, unavailable: undefined });
		const status = header.element.querySelector('[role="status"]');
		assert.equal(status?.textContent, "working");
		const elapsed = header.element.querySelector(".elapsed");
		assert.equal(elapsed?.getAttribute("aria-hidden"), "true");
		assert.equal(status?.contains(elapsed ?? null), false);
	});

	it("keeps the todo list and queue nodes when the session changes elsewhere", () => {
		const panel = new SessionPanel(new OpenStateStore(), () => {});
		const todos = [{ name: "Build", tasks: [{ content: "write code", status: "in_progress" }] }];
		const queue = { steering: ["go left"], followUp: [] };
		panel.render(session({ todos, queue }));
		const todoNode = panel.todos.firstElementChild;
		const queueChip = panel.queue.firstElementChild;
		panel.render(session({ todos: structuredClone(todos), queue: structuredClone(queue), costUsd: 0.5 }));
		assert.ok(panel.todos.firstElementChild === todoNode, "the todo list node was replaced");
		assert.ok(panel.queue.firstElementChild === queueChip, "the queue chip was replaced");
		panel.render(session({ todos: [{ name: "Build", tasks: [{ content: "write code", status: "completed" }] }], queue }));
		assert.ok(panel.todos.firstElementChild !== todoNode, "the changed todo list was not re-rendered");
	});

	it("reflects fast mode through aria-pressed only", () => {
		const controls = new SessionControls(() => {});
		controls.render(session({ fastModeEnabled: true }));
		assert.equal(controls.fastButton.getAttribute("aria-pressed"), "true");
		assert.equal(controls.fastButton.classList.contains("on"), false);
	});
});
