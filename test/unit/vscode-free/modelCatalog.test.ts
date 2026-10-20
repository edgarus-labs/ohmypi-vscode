import * as assert from "node:assert/strict";
import type { ModelView } from "../../../src/omp/api";
import { type CatalogOptions, catalogGroups, modelItemText } from "../../../src/ui/modelCatalog";

function model(provider: string, id: string, name = id, identity?: ModelView["identity"]): ModelView {
	return { provider, id, name, reasoning: false, thinkingEfforts: [], input: ["text"], ...(identity ? { identity } : {}) };
}

const NO_FILTER: CatalogOptions = { favorites: [], recents: [], favoritesOnly: false, recentOnly: false };

function layout(models: ModelView[], options: Partial<CatalogOptions> = {}): Array<[string, string[]]> {
	return catalogGroups(models, { ...NO_FILTER, ...options }).map(group => [group.provider, group.entries.map(entry => entry.label)]);
}

describe("model catalog", () => {
	it("groups models per provider by name, the current provider first, each model once", () => {
		const models = [model("openai", "o3"), model("Anthropic", "claude"), model("zai", "glm"), model("openai", "o1"), model("openai", "o1")];
		assert.deepEqual(layout(models, { currentProvider: "zai" }), [
			["zai", ["glm"]],
			["Anthropic", ["claude"]],
			["openai", ["o1", "o3"]],
		]);
	});

	it("orders a provider's models by family, newest revision first, then the unclassified ones in natural order", () => {
		const models = [
			model("anthropic", "GPT-10"),
			model("anthropic", "opus-4", "Opus 4", { class: "anthropic", family: "opus", revision: "4.0.0" }),
			model("anthropic", "sonnet-3.7", "Sonnet 3.7", { class: "anthropic", family: "sonnet", revision: "3.7.0" }),
			model("anthropic", "GPT-5"),
			model("anthropic", "opus-4.1", "Opus 4.1", { class: "anthropic", family: "opus", revision: "4.1.0" }),
			model("anthropic", "sonnet-4.5", "Sonnet 4.5", { class: "anthropic", family: "sonnet", revision: "4.5.0" }),
			model("anthropic", "sonnet-x", "Sonnet X", { class: "anthropic", family: "sonnet" }),
		];
		assert.deepEqual(layout(models), [["anthropic", ["Sonnet 4.5", "Sonnet 3.7", "Sonnet X", "Opus 4.1", "Opus 4", "GPT-5", "GPT-10"]]]);
	});

	it("tells apart models of one provider that share a name by the part of the id that differs", () => {
		const models = [
			model("anthropic", "claude-sonnet-4-20250514", "Claude Sonnet 4"),
			model("anthropic", "claude-sonnet-4-thinking", "Claude Sonnet 4"),
			model("openai", "gpt-5", "GPT-5"),
			model("openai", "gpt-5-codex", "GPT-5"),
			model("google", "gemini", "Shared"),
			model("xai", "grok", "Shared"),
		];
		assert.deepEqual(layout(models), [
			["anthropic", ["Claude Sonnet 4 (20250514)", "Claude Sonnet 4 (thinking)"]],
			["google", ["Shared"]],
			["openai", ["GPT-5 (gpt-5)", "GPT-5 (gpt-5-codex)"]],
			["xai", ["Shared"]],
		]);
	});

	it("keeps favorites under the Favorites filter and recent picks in pick order under the Recent filter", () => {
		const models = [model("p", "a"), model("p", "b"), model("p", "c"), model("q", "d")];
		const favorites = ["p/a", "p/c"];
		const recents = ["p/c", "q/d", "p/b", "p/gone"];
		assert.deepEqual(layout(models, { favorites, recents, favoritesOnly: true }), [["p", ["a", "c"]]]);
		assert.deepEqual(layout(models, { favorites, recents, recentOnly: true }), [
			["p", ["c", "b"]],
			["q", ["d"]],
		]);
		assert.deepEqual(layout(models, { favorites, recents, favoritesOnly: true, recentOnly: true }), [["p", ["c"]]]);
	});

	it("shows a model's context and price beside it and its id and capabilities below", () => {
		const full: ModelView = {
			...model("anthropic", "claude", "Claude"),
			contextWindow: 200_000,
			maxTokens: 64_000,
			reasoning: true,
			thinkingEfforts: ["low", "high"],
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		};
		assert.deepEqual(modelItemText(full), {
			description: "200k · $3 / $15",
			detail: "anthropic/claude · out 64k · reasoning: low, high · in: text, image",
		});
		assert.deepEqual(modelItemText(model("p", "m")), { description: "", detail: "p/m · in: text" });
	});
});
