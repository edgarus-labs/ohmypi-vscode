import * as assert from "node:assert/strict";
import { resolveExecutable } from "../../src/omp/executable";

function fsWith(...files: string[]) {
	const set = new Set(files);
	return { isExecutableFile: (p: string) => set.has(p) };
}

describe("resolveExecutable", () => {
	const env = { HOME: "/home/u", PATH: "/usr/bin:/opt/omp/bin" };

	it("uses a configured path with ~ expansion when it exists", () => {
		assert.equal(resolveExecutable("~/tools/omp", env, "linux", fsWith("/home/u/tools/omp")), "/home/u/tools/omp");
	});

	it("fails clearly when the configured path does not exist", () => {
		assert.throws(
			() => resolveExecutable("/nope/omp", env, "linux", fsWith("/opt/omp/bin/omp")),
			(error: Error) => error.message.includes("/nope/omp") && /omp\.executablePath/.test(error.message),
		);
	});

	it("searches PATH in order when nothing is configured", () => {
		assert.equal(resolveExecutable("", env, "linux", fsWith("/opt/omp/bin/omp")), "/opt/omp/bin/omp");
		assert.equal(resolveExecutable(undefined, env, "linux", fsWith("/usr/bin/omp", "/opt/omp/bin/omp")), "/usr/bin/omp");
	});

	it("falls back to ~/.local/bin and ~/.bun/bin", () => {
		assert.equal(resolveExecutable("", env, "linux", fsWith("/home/u/.local/bin/omp")), "/home/u/.local/bin/omp");
		assert.equal(resolveExecutable("", env, "linux", fsWith("/home/u/.bun/bin/omp")), "/home/u/.bun/bin/omp");
	});

	it("looks for omp.exe and omp.cmd on win32 using the Path variable", () => {
		const winEnv = { USERPROFILE: "C:\\Users\\u", Path: "C:\\bin;C:\\tools" };
		assert.equal(resolveExecutable("", winEnv, "win32", fsWith("C:\\tools\\omp.cmd")), "C:\\tools\\omp.cmd");
		assert.equal(resolveExecutable("", winEnv, "win32", fsWith("C:\\bin\\omp.exe")), "C:\\bin\\omp.exe");
	});

	it("lists every location tried when nothing is found", () => {
		assert.throws(
			() => resolveExecutable("", env, "linux", fsWith()),
			(error: Error) =>
				["/usr/bin/omp", "/opt/omp/bin/omp", "/home/u/.local/bin/omp", "/home/u/.bun/bin/omp"].every(p =>
					error.message.includes(p),
				),
		);
	});
});
