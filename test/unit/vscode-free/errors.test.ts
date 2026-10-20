import * as assert from "node:assert/strict";
import { OmpRequestError } from "../../../src/omp/client";
import { describeError, errorMessage } from "../../../src/shared/errors";

describe("errorMessage", () => {
	it("uses the message of errors and stringifies anything else", () => {
		assert.equal(errorMessage(new Error("boom")), "boom");
		assert.equal(errorMessage("plain"), "plain");
		assert.equal(errorMessage(42), "42");
	});
});

describe("describeError", () => {
	it("includes the stack of an error", () => {
		const error = new Error("boom");
		assert.equal(describeError(error), error.stack);
	});

	it("includes the OMP code and command of a request error", () => {
		const text = describeError(new OmpRequestError("bash failed", "bash", "permission_denied"));
		assert.match(text, /OmpRequestError: bash failed/);
		assert.match(text, /code=permission_denied/);
		assert.match(text, /command=bash/);
	});

	it("includes the code of a system error", () => {
		const error = Object.assign(new Error("spawn omp ENOENT"), { code: "ENOENT" });
		assert.match(describeError(error), /code=ENOENT/);
	});

	it("stringifies non-errors", () => {
		assert.equal(describeError("plain"), "plain");
	});
});
