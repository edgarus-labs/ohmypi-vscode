import * as assert from "node:assert/strict";
import { deferred } from "../../../src/shared/deferred";

describe("deferred", () => {
	it("settles its promise through the exposed resolve", async () => {
		const pending = deferred<number>();
		pending.resolve(7);
		assert.equal(await pending.promise, 7);
	});

	it("settles its promise through the exposed reject", async () => {
		const pending = deferred<number>();
		pending.reject(new Error("boom"));
		await assert.rejects(pending.promise, /boom/);
	});
});
