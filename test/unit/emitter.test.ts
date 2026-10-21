import * as assert from "node:assert/strict";
import { Emitter } from "../../src/omp/emitter";

describe("Emitter", () => {
	it("delivers values to listeners until disposed", () => {
		const emitter = new Emitter<number>();
		const seen: number[] = [];
		const sub = emitter.event(v => seen.push(v));
		emitter.fire(1);
		sub.dispose();
		emitter.fire(2);
		assert.deepEqual(seen, [1]);
	});

	it("keeps notifying remaining listeners when one throws and reports the error", () => {
		const errors: unknown[] = [];
		const emitter = new Emitter<string>(error => errors.push(error));
		const seen: string[] = [];
		emitter.event(() => {
			throw new Error("boom");
		});
		emitter.event(v => seen.push(v));
		emitter.fire("x");
		assert.deepEqual(seen, ["x"]);
		assert.equal(errors.length, 1);
		assert.equal((errors[0] as Error).message, "boom");
	});

	it("rethrows a listener error when no error handler is configured", () => {
		const emitter = new Emitter<string>();
		const seen: string[] = [];
		emitter.event(() => {
			throw new Error("boom");
		});
		emitter.event(v => seen.push(v));
		assert.throws(() => emitter.fire("x"), /boom/);
		assert.deepEqual(seen, ["x"]);
	});

	it("drops all listeners on dispose", () => {
		const emitter = new Emitter<number>();
		const seen: number[] = [];
		emitter.event(v => seen.push(v));
		emitter.dispose();
		emitter.fire(1);
		assert.deepEqual(seen, []);
	});

	it("skips a listener disposed by an earlier listener during the same fire", () => {
		const emitter = new Emitter<number>();
		const seen: string[] = [];
		emitter.event(() => {
			seen.push("first");
			second.dispose();
		});
		const second = emitter.event(() => seen.push("second"));
		emitter.fire(1);
		assert.deepEqual(seen, ["first"]);
	});

	it("stops delivering when a listener disposes the emitter during fire", () => {
		const emitter = new Emitter<number>();
		const seen: string[] = [];
		emitter.event(() => {
			seen.push("first");
			emitter.dispose();
		});
		emitter.event(() => seen.push("second"));
		emitter.fire(1);
		assert.deepEqual(seen, ["first"]);
	});

	it("treats each subscription of the same function separately", () => {
		const emitter = new Emitter<number>();
		const seen: number[] = [];
		const listener = (value: number) => seen.push(value);
		const first = emitter.event(listener);
		emitter.event(listener);
		emitter.fire(1);
		first.dispose();
		emitter.fire(2);
		assert.deepEqual(seen, [1, 1, 2]);
	});

	it("ignores subscriptions made after dispose", () => {
		const emitter = new Emitter<number>();
		const seen: number[] = [];
		emitter.dispose();
		const sub = emitter.event(v => seen.push(v));
		emitter.fire(1);
		sub.dispose();
		assert.deepEqual(seen, []);
	});

	it("keeps delivering when the error handler itself throws and rethrows that failure afterwards", () => {
		const emitter = new Emitter<string>(() => {
			throw new Error("handler broke");
		});
		const seen: string[] = [];
		emitter.event(() => {
			throw new Error("boom");
		});
		emitter.event(v => seen.push(v));
		assert.throws(() => emitter.fire("x"), /handler broke/);
		assert.deepEqual(seen, ["x"]);
	});
});
