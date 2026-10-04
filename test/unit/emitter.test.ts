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
});
