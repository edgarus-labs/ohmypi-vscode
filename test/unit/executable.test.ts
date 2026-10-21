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

	it("rejects a relative configured path", () => {
		assert.throws(
			() => resolveExecutable("./tools/omp", env, "linux", fsWith("./tools/omp")),
			(error: Error) => /omp\.executablePath/.test(error.message) && /absolute/.test(error.message) && error.message.includes("./tools/omp"),
		);
		assert.throws(
			() => resolveExecutable("tools\\omp.cmd", { USERPROFILE: "C:\\Users\\u" }, "win32", fsWith("tools\\omp.cmd")),
			/absolute/,
		);
	});

	it("rejects a configured win32 path that Windows cannot launch", () => {
		assert.throws(
			() => resolveExecutable("C:\\tools\\omp", { USERPROFILE: "C:\\Users\\u" }, "win32", fsWith("C:\\tools\\omp")),
			(error: Error) => /\.exe/.test(error.message) && /\.cmd/.test(error.message) && error.message.includes("C:\\tools\\omp"),
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

	it("skips an extensionless omp on win32 for a launcher Windows can run", () => {
		const winEnv = { USERPROFILE: "C:\\Users\\u", Path: "C:\\bin;C:\\tools" };
		assert.equal(resolveExecutable("", winEnv, "win32", fsWith("C:\\bin\\omp", "C:\\tools\\omp.cmd")), "C:\\tools\\omp.cmd");
	});

	it("strips the quotes Windows allows around a Path entry", () => {
		const winEnv = { USERPROFILE: "C:\\Users\\u", Path: 'C:\\bin;"C:\\Program Files\\omp";"D:\\a;b";C:\\tools' };
		assert.equal(resolveExecutable("", winEnv, "win32", fsWith("C:\\Program Files\\omp\\omp.exe")), "C:\\Program Files\\omp\\omp.exe");
		assert.equal(resolveExecutable("", winEnv, "win32", fsWith("D:\\a;b\\omp.cmd")), "D:\\a;b\\omp.cmd");
	});

	it("expands ~\\ in a configured win32 path under USERPROFILE and keeps spaces", () => {
		const winEnv = { USERPROFILE: "C:\\Users\\John Doe", HOME: "D:\\elsewhere" };
		const expected = "C:\\Users\\John Doe\\AppData\\Local\\omp\\omp.exe";
		assert.equal(resolveExecutable("~\\AppData\\Local\\omp\\omp.exe", winEnv, "win32", fsWith(expected)), expected);
		assert.equal(resolveExecutable("~/AppData/Local/omp/omp.exe", winEnv, "win32", fsWith(expected)), expected);
	});

	it("falls back to HOME on win32 when USERPROFILE is unset", () => {
		const winEnv = { HOME: "C:\\Users\\u", Path: "" };
		assert.equal(resolveExecutable("", winEnv, "win32", fsWith("C:\\Users\\u\\.bun\\bin\\omp.exe")), "C:\\Users\\u\\.bun\\bin\\omp.exe");
		assert.equal(resolveExecutable("~\\bin\\omp.cmd", winEnv, "win32", fsWith("C:\\Users\\u\\bin\\omp.cmd")), "C:\\Users\\u\\bin\\omp.cmd");
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
