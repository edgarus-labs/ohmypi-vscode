import * as assert from "node:assert/strict";
import * as path from "node:path";
import { ToolArguments } from "../../src/vscode/hostTools/arguments";

describe("host tool arguments", () => {
	const cwd = path.resolve("/work/repo");
	const docs = path.resolve("/work/docs");
	const args = (values: Record<string, unknown>) => new ToolArguments(values, { cwd, roots: [cwd, docs] });

	it("requires a non-blank string, allowing an empty one only where asked", () => {
		assert.throws(() => args({}).requiredString("command"), { message: "'command' is required" });
		assert.throws(() => args({ command: null }).requiredString("command"), { message: "'command' is required" });
		assert.throws(() => args({ command: "  " }).requiredString("command"), { message: "'command' must not be empty" });
		assert.throws(() => args({ command: 3 }).requiredString("command"), { message: "'command' must be a string" });
		assert.equal(args({ text: "" }).requiredString("text", true), "");
		assert.equal(args({ command: "go" }).requiredString("command"), "go");
	});

	it("treats a missing, null or blank optional string as absent", () => {
		assert.equal(args({}).optionalString("name"), undefined);
		assert.equal(args({ name: null }).optionalString("name"), undefined);
		assert.equal(args({ name: " " }).optionalString("name"), undefined);
		assert.equal(args({ name: "build" }).optionalString("name"), "build");
		assert.throws(() => args({ name: false }).optionalString("name"), { message: "'name' must be a string" });
	});

	it("accepts whole numbers from the minimum up to the 32-bit limit", () => {
		assert.equal(args({ line: 3 }).requiredInt("line", 1), 3);
		assert.equal(args({ line: 4.0 }).optionalInt("line", 1), 4);
		assert.equal(args({ endLine: 0 }).requiredInt("endLine", 0), 0);
		assert.equal(args({}).optionalInt("line", 1), undefined);
		assert.throws(() => args({}).requiredInt("line", 1), { message: "'line' is required" });
		for (const bad of [0, 1.5, "2", true, 2 ** 31, Number.NaN]) {
			assert.throws(() => args({ line: bad }).optionalInt("line", 1), { message: "'line' must be an integer >= 1" }, String(bad));
		}
	});

	it("requires booleans to be JSON booleans", () => {
		assert.equal(args({ save: true }).optionalBool("save"), true);
		assert.equal(args({}).optionalBool("save"), undefined);
		assert.throws(() => args({ save: "true" }).optionalBool("save"), { message: "'save' must be true or false" });
	});

	it("matches choices exactly against the allowed values", () => {
		const allowed = ["error", "warning"] as const;
		assert.equal(args({ severity: "warning" }).optionalChoice("severity", allowed, "error"), "warning");
		assert.equal(args({}).optionalChoice("severity", allowed, "error"), "error");
		assert.throws(() => args({ severity: "Error" }).optionalChoice("severity", allowed, "error"), {
			message: "'severity' must be one of: error, warning (got 'Error')",
		});
		assert.throws(() => args({}).requiredChoice("action", allowed), { message: "'action' is required (one of: error, warning)" });
	});

	it("resolves paths against the working directory and accepts only paths inside a workspace root", () => {
		assert.equal(args({ path: "src/a.ts" }).requiredPath("path"), path.join(cwd, "src", "a.ts"));
		assert.equal(args({ path: path.join(docs, "guide.md") }).requiredPath("path"), path.join(docs, "guide.md"));
		assert.equal(args({}).optionalPath("path"), undefined);
		const outside = path.resolve("/etc/hosts");
		assert.throws(() => args({ path: outside }).requiredPath("path"), { message: `'path' must be inside the workspace (${cwd}): ${outside}` });
		assert.throws(() => args({ path: "../other/x.ts" }).requiredPath("path"), /must be inside the workspace/);
		assert.throws(() => args({ path: "https://example.com/a.ts" }).requiredPath("path"), {
			message: "'path' is not a local file path: https://example.com/a.ts",
		});
		assert.throws(() => args({ path: " " }).requiredPath("path"), { message: "'path' must not be empty" });
	});
});
