import * as assert from "node:assert/strict";
import { ModelPreferences, modelKey, type PreferenceMemento, RECENT_LIMIT } from "../../../src/ui/modelPreferences";

class MemoryMemento implements PreferenceMemento {
	readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

describe("ModelPreferences", () => {
	let memento: MemoryMemento;

	beforeEach(() => {
		memento = new MemoryMemento();
	});

	it("toggles a favorite on and off, stored as escaped provider/id", async () => {
		const key = modelKey({ provider: "openrouter", id: "anthropic/claude" });
		assert.equal(await new ModelPreferences(memento).toggleFavorite(key), true);
		assert.deepEqual([...memento.values.values()], [["openrouter/anthropic%2Fclaude"]]);
		const reloaded = new ModelPreferences(memento);
		assert.deepEqual(reloaded.favorites, [key]);
		assert.equal(await reloaded.toggleFavorite(key), false);
		assert.deepEqual(new ModelPreferences(memento).favorites, []);
	});

	it("records picked models most recent first, once each, keeping the last 20", async () => {
		const preferences = new ModelPreferences(memento);
		const keys = Array.from({ length: RECENT_LIMIT + 2 }, (_, index) => modelKey({ provider: "p", id: `m${index}` }));
		for (const key of keys) await preferences.recordPicked(key);
		await preferences.recordPicked(keys[10]);
		const recents = new ModelPreferences(memento).recents;
		assert.equal(RECENT_LIMIT, 20);
		assert.equal(recents.length, 20);
		assert.deepEqual(recents.slice(0, 3), [keys[10], keys[21], keys[20]]);
		assert.equal(new Set(recents).size, 20);
		assert.equal(recents.includes(keys[1]), false);
	});

	it("keeps the Favorites and Recent filters across instances", async () => {
		const preferences = new ModelPreferences(memento);
		assert.equal(preferences.favoritesOnly, false);
		assert.equal(preferences.recentOnly, false);
		await preferences.setFavoritesOnly(true);
		await preferences.setRecentOnly(true);
		const reloaded = new ModelPreferences(memento);
		assert.equal(reloaded.favoritesOnly, true);
		assert.equal(reloaded.recentOnly, true);
		await reloaded.setFavoritesOnly(false);
		assert.equal(new ModelPreferences(memento).favoritesOnly, false);
	});

	it("ignores stored values that are not lists of model keys", () => {
		for (const key of ["omp.modelPicker.favorites", "omp.modelPicker.recents"]) memento.values.set(key, ["p/a", 3, "no-slash", "p/a", "a/b/c", null]);
		memento.values.set("omp.modelPicker.favoritesOnly", "yes");
		const preferences = new ModelPreferences(memento);
		assert.deepEqual(preferences.favorites, ["p/a"]);
		assert.deepEqual(preferences.recents, ["p/a"]);
		assert.equal(preferences.favoritesOnly, false);
		memento.values.set("omp.modelPicker.favorites", "p/a");
		assert.deepEqual(new ModelPreferences(memento).favorites, []);
	});
});
