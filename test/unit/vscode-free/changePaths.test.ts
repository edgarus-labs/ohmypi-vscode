import * as assert from "node:assert/strict";
import * as path from "node:path";
import { lineDelta, resolveToolPath, toolArgPaths, toolResultFiles } from "../../../src/vscode/changePaths";

const cwd = path.resolve("/work/repo");

describe("resolveToolPath", () => {
	it("resolves relative paths against cwd and keeps absolute ones", () => {
		assert.equal(resolveToolPath("src/a.ts", cwd), path.join(cwd, "src/a.ts"));
		assert.equal(resolveToolPath(path.resolve("/abs/b.ts"), cwd), path.resolve("/abs/b.ts"));
	});

	it("ignores URLs and internal schemes", () => {
		assert.equal(resolveToolPath("xd://ast_grep", cwd), undefined);
		assert.equal(resolveToolPath("https://example.com/a", cwd), undefined);
		assert.equal(resolveToolPath("skill://rules", cwd), undefined);
		assert.equal(resolveToolPath("", cwd), undefined);
	});
});

describe("toolArgPaths", () => {
	it("collects path, file, paths[], oldPath/newPath and edits[].path", () => {
		assert.deepEqual(toolArgPaths({ path: "a.ts" }), ["a.ts"]);
		assert.deepEqual(toolArgPaths({ file: "b.ts" }), ["b.ts"]);
		assert.deepEqual(toolArgPaths({ paths: ["c.ts", 3, "d.ts"] }), ["c.ts", "d.ts"]);
		assert.deepEqual(toolArgPaths({ oldPath: "o.ts", newPath: "n.ts" }), ["o.ts", "n.ts"]);
		assert.deepEqual(toolArgPaths({ edits: [{ path: "e.ts" }, { path: "e.ts" }, {}] }), ["e.ts"]);
	});

	it("parses apply_patch style headers from an input string", () => {
		const input =
			"*** Begin Patch\n*** Add File: hello.txt\n+Hello\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@\n*** Delete File: old.txt\n*** End Patch\n";
		assert.deepEqual(toolArgPaths({ input }), ["hello.txt", "src/app.py", "src/main.py", "old.txt"]);
	});

	it("returns nothing for non-objects", () => {
		assert.deepEqual(toolArgPaths(undefined), []);
		assert.deepEqual(toolArgPaths("a.ts"), []);
		assert.deepEqual(toolArgPaths({ path: 5 }), []);
	});
});

describe("toolResultFiles", () => {
	it("reads details.path, resolvedPath and oldText", () => {
		assert.deepEqual(toolResultFiles({ path: "/x/a.ts", oldText: "old" }), [{ path: "/x/a.ts", oldText: "old" }]);
		assert.deepEqual(toolResultFiles({ resolvedPath: "/x/w.ts" }), [{ path: "/x/w.ts" }]);
	});

	it("reads perFileResults entries including move sources", () => {
		assert.deepEqual(
			toolResultFiles({
				perFileResults: [
					{ path: "/x/a.ts", oldText: "a0" },
					{ path: "/x/new.ts", sourcePath: "/x/old.ts" },
				],
			}),
			[{ path: "/x/a.ts", oldText: "a0" }, { path: "/x/new.ts" }, { path: "/x/old.ts" }],
		);
	});

	it("dedupes and tolerates junk", () => {
		assert.deepEqual(toolResultFiles({ path: "/x/a.ts", resolvedPath: "/x/a.ts" }), [{ path: "/x/a.ts" }]);
		assert.deepEqual(toolResultFiles(undefined), []);
		assert.deepEqual(toolResultFiles("str"), []);
		assert.deepEqual(toolResultFiles({ perFileResults: "nope" }), []);
	});
});

describe("lineDelta", () => {
	it("counts added and removed lines", () => {
		assert.deepEqual(lineDelta("a\nb\nc\n", "a\nB\nc\nd\n"), { added: 2, removed: 1 });
		assert.deepEqual(lineDelta(null, "x\ny"), { added: 2, removed: 0 });
		assert.deepEqual(lineDelta("x\ny\n", null), { added: 0, removed: 2 });
		assert.deepEqual(lineDelta("same\n", "same\n"), { added: 0, removed: 0 });
	});
});
