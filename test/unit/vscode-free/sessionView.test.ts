import * as assert from "node:assert/strict";
import { effortChoices, emptySessionView } from "../../../src/shared/session";

describe("emptySessionView", () => {
	it("is an idle session without state, fresh on every call", () => {
		const view = emptySessionView();
		assert.equal(view.phase, "idle");
		assert.deepEqual(view.queue, { steering: [], followUp: [] });
		assert.notEqual(emptySessionView().todos, view.todos);
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
