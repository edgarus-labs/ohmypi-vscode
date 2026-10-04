import * as assert from "node:assert/strict";
import { toModelView } from "../../src/omp/models";
import type { ModelInfo } from "../../src/omp/protocol";

const wire: ModelInfo = {
	id: "claude-x",
	name: "Claude X",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 64000,
	thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
};

describe("toModelView", () => {
	it("maps identity, limits, modalities, pricing and thinking efforts", () => {
		assert.deepEqual(toModelView(wire), {
			provider: "anthropic",
			id: "claude-x",
			name: "Claude X",
			api: "anthropic-messages",
			contextWindow: 200000,
			maxTokens: 64000,
			reasoning: true,
			thinkingEfforts: ["low", "medium", "high"],
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
	});

	it("tolerates null limits and missing thinking/cost/name", () => {
		const view = toModelView({
			...wire,
			name: undefined as unknown as string,
			contextWindow: null,
			maxTokens: null,
			thinking: undefined,
			cost: undefined as unknown as ModelInfo["cost"],
			input: undefined as unknown as string[],
		});
		assert.equal(view.name, "claude-x");
		assert.equal(view.contextWindow, undefined);
		assert.equal(view.maxTokens, undefined);
		assert.deepEqual(view.thinkingEfforts, []);
		assert.deepEqual(view.input, ["text"]);
		assert.equal(view.cost, undefined);
	});
});
