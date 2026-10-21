import * as assert from "node:assert/strict";
import { composerAction, isAtBottom, stateWord, todoSummary, usageText } from "../../../src/webview/chrome";

describe("conversation chrome helpers", () => {
	it("derives the header state word", () => {
		const base = { connection: "ready", phase: "idle", pendingInteractions: 0, unavailable: false } as const;
		assert.equal(stateWord(base), "idle");
		assert.equal(stateWord({ ...base, phase: "submitting" }), "working");
		assert.equal(stateWord({ ...base, phase: "running" }), "working");
		assert.equal(stateWord({ ...base, phase: "yielded" }), "working");
		assert.equal(stateWord({ ...base, phase: "aborting" }), "aborting");
		assert.equal(stateWord({ ...base, phase: "running", pendingInteractions: 1 }), "waiting");
		assert.equal(stateWord({ ...base, connection: "starting" }), "starting");
		assert.equal(stateWord({ ...base, connection: "restarting", phase: "running" }), "starting");
		assert.equal(stateWord({ ...base, connection: "stopped" }), "offline");
		assert.equal(stateWord({ ...base, connection: "failed" }), "offline");
		assert.equal(stateWord({ ...base, unavailable: true }), "offline");
	});

	it("summarizes todos with the task in progress", () => {
		assert.equal(todoSummary([]), undefined);
		assert.equal(todoSummary([{ name: "p", tasks: [] }]), undefined);
		const phases = [
			{ name: "Plan", tasks: [{ content: "Read code", status: "completed" }, { content: "Sketch", status: "completed" }] },
			{ name: "Build", tasks: [{ content: "Write   the\nparser", status: "in_progress" }, { content: "Test", status: "pending" }, { content: "Ship", status: "pending" }] },
		];
		assert.equal(todoSummary(phases), "todos 2/5 · current: Write the parser");
		assert.equal(todoSummary([{ name: "p", tasks: [{ content: "a", status: "pending" }] }]), "todos 0/1");
	});

	it("leaves abandoned tasks out of the todo count, so a finished list reads N/N", () => {
		const phases = [{ name: "p", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "abandoned" }, { content: "c", status: "blocked" }] }];
		assert.equal(todoSummary(phases), "todos 1/2");
		assert.equal(todoSummary([{ name: "p", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "abandoned" }] }]), "todos 1/1");
	});

	it("formats context usage and cost", () => {
		assert.equal(usageText({}), "");
		assert.equal(usageText({ contextUsage: { tokens: 13_000, contextWindow: 100_000, percent: 13.2 } }), "ctx 13%");
		assert.equal(usageText({ costUsd: 0.02149 }), "$0.0215");
		assert.equal(usageText({ contextUsage: { tokens: 1, contextWindow: 2, percent: 50 }, costUsd: 3.456 }), "ctx 50% · $3.46");
	});

	it("detects the bottom of a scroll container", () => {
		assert.equal(isAtBottom(1000, 600, 400), true);
		assert.equal(isAtBottom(1000, 590, 400), true);
		assert.equal(isAtBottom(1000, 500, 400), false);
		assert.equal(isAtBottom(300, 0, 400), true);
	});

	it("picks the primary composer action: send when idle, steer with text while busy, else stop", () => {
		assert.equal(composerAction({ busy: false, hasContent: false }), "send");
		assert.equal(composerAction({ busy: false, hasContent: true }), "send");
		assert.equal(composerAction({ busy: true, hasContent: true }), "steer");
		assert.equal(composerAction({ busy: true, hasContent: false }), "stop");
	});
});
