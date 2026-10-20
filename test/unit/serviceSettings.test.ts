import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { readServiceSettings } from "../../src/ui/serviceSettings";
import { FAKE_OMP } from "./helpers";
import { stub } from "./stubs/vscode";

describe("readServiceSettings", () => {
	const read = () => readServiceSettings(vscode.workspace.getConfiguration("omp"), {}, process.platform);

	beforeEach(() => {
		stub.reset();
		stub.config.set("omp.executablePath", path.resolve(FAKE_OMP));
	});

	it("reads the executable, extra arguments and restart policy", () => {
		stub.config.set("omp.extraArgs", ["--profile", "work"]);
		stub.config.set("omp.autoRestart", false);
		assert.deepEqual(read(), { executable: path.resolve(FAKE_OMP), extraArgs: ["--profile", "work"], autoRestart: false });
	});

	it("defaults to no extra arguments and automatic restarts", () => {
		assert.deepEqual(read(), { executable: path.resolve(FAKE_OMP), extraArgs: [], autoRestart: true });
	});

	for (const value of ["--profile work", 42, ["--profile", 7], { profile: "work" }]) {
		it(`rejects omp.extraArgs set to ${JSON.stringify(value)}`, () => {
			stub.config.set("omp.extraArgs", value);
			assert.throws(read, /omp\.extraArgs must be an array of strings/);
		});
	}
});
