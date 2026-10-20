import * as assert from "node:assert/strict";
import { TodoDismissals } from "../../../src/ui/todoDismissals";

class MemoryMemento {
	readonly values = new Map<string, unknown>();

	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}

	update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
		return Promise.resolve();
	}
}

describe("todo dismissals", () => {
	it("remembers dismissals newest first across instances, at most 100", async () => {
		const memento = new MemoryMemento();
		const first = new TodoDismissals(memento);
		for (let i = 0; i < 101; i++) await first.add(`todos:${i}`);
		await first.add("todos:50");
		const list = new TodoDismissals(memento).list();
		assert.equal(list.length, 100);
		assert.deepEqual(list.slice(0, 3), ["todos:50", "todos:100", "todos:99"]);
		assert.equal(list.filter(key => key === "todos:50").length, 1);
		assert.ok(!list.includes("todos:0"), "the oldest dismissal is forgotten");
	});

	it("reads a stored value that is not a list of keys as no dismissals", () => {
		const memento = new MemoryMemento();
		memento.values.set("omp.dismissedTodos", "todos:1");
		assert.deepEqual(new TodoDismissals(memento).list(), []);
		memento.values.set("omp.dismissedTodos", ["todos:1", 2]);
		assert.deepEqual(new TodoDismissals(memento).list(), ["todos:1"]);
	});
});
