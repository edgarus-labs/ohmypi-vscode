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

	it("prices missing cache rates at zero and drops pricing without input and output rates", () => {
		const partial = { input: 1, output: 2 } as unknown as ModelInfo["cost"];
		assert.deepEqual(toModelView({ ...wire, cost: partial }).cost, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
		const unpriced = { input: "1", output: 2, cacheRead: 0, cacheWrite: 0 } as unknown as ModelInfo["cost"];
		assert.equal(toModelView({ ...wire, cost: unpriced }).cost, undefined);
	});

	it("keeps the class, family and revision OMP identifies the model by, dropping non-string parts", () => {
		const identity = { class: "anthropic", family: "opus", revision: "4.1.0" };
		assert.deepEqual(toModelView({ ...wire, identity }).identity, identity);
		assert.deepEqual(toModelView({ ...wire, identity: { class: "openai", family: 5, revision: null } as unknown as ModelInfo["identity"] }).identity, {
			class: "openai",
		});
		assert.equal(toModelView(wire).identity, undefined);
	});
});
