import * as assert from "node:assert/strict";
import { effortChoices, elapsedText, isAtBottom, stateWord, todoSummary, usageText } from "../../../src/webview/chrome";

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

	it("formats context usage and cost", () => {
		assert.equal(usageText({}), "");
		assert.equal(usageText({ contextUsage: { tokens: 13_000, contextWindow: 100_000, percent: 13.2 } }), "ctx 13%");
		assert.equal(usageText({ costUsd: 0.02149 }), "$0.0215");
		assert.equal(usageText({ contextUsage: { tokens: 1, contextWindow: 2, percent: 50 }, costUsd: 3.456 }), "ctx 50% · $3.46");
	});

	it("formats elapsed time", () => {
		assert.equal(elapsedText(0), "0s");
		assert.equal(elapsedText(12_400), "12s");
		assert.equal(elapsedText(65_000), "1m 05s");
		assert.equal(elapsedText(3_725_000), "1h 02m");
		assert.equal(elapsedText(-5), "0s");
	});

	it("detects the bottom of a scroll container", () => {
		assert.equal(isAtBottom(1000, 600, 400), true);
		assert.equal(isAtBottom(1000, 590, 400), true);
		assert.equal(isAtBottom(1000, 500, 400), false);
		assert.equal(isAtBottom(300, 0, 400), true);
	});
});

describe("effortChoices", () => {
	const levels = ["off", "auto", "low", "medium", "high"];

	it("selects the user's selector, not the effective level", () => {
		const choices = effortChoices({ availableThinkingLevels: levels, thinkingSelector: "auto", thinkingLevel: "high" });
		assert.equal(choices.value, "auto");
		assert.deepEqual(
			choices.options.map(option => option.label),
			["off", "auto", "low", "medium", "high"],
		);
	});

	it("shows what auto resolved to once OMP classified the turn", () => {
		const choices = effortChoices({ availableThinkingLevels: levels, thinkingSelector: "auto", thinkingLevel: "low", thinkingResolved: "low" });
		assert.equal(choices.options.find(option => option.value === "auto")?.label, "auto · low");
	});

	it("falls back to the effective level when the selector is unknown", () => {
		assert.equal(effortChoices({ availableThinkingLevels: levels, thinkingLevel: "medium" }).value, "medium");
	});
});
