import * as assert from "node:assert/strict";
import type * as vscode from "vscode";
import { OmpRequestError } from "../../src/omp/client";
import { OutputLogger } from "../../src/vscode/logger";
import { stub } from "./stubs/vscode";

describe("OutputLogger", () => {
	let lines: string[];
	let logger: OutputLogger;

	beforeEach(() => {
		stub.reset();
		lines = [];
		logger = new OutputLogger({ appendLine: (line: string) => lines.push(line) } as unknown as vscode.OutputChannel);
	});

	it("reads omp.traceRpc on every check", () => {
		assert.equal(logger.traceEnabled, false);
		stub.config.set("omp.traceRpc", true);
		assert.equal(logger.traceEnabled, true);
	});

	it("appends the failure to warnings, with OMP's code and command", () => {
		logger.warn("Refreshing OMP state failed", new OmpRequestError("get_state failed", "get_state", "session_busy"));
		assert.equal(lines.length, 1);
		assert.match(lines[0], /\[warn\] Refreshing OMP state failed: OmpRequestError: get_state failed/);
		assert.match(lines[0], /code=session_busy command=get_state/);
	});

	it("drops messages below omp.logLevel", () => {
		logger.debug("hidden");
		stub.config.set("omp.logLevel", "debug");
		logger.debug("shown");
		assert.equal(lines.length, 1);
		assert.match(lines[0], /\[debug\] shown$/);
	});
});
