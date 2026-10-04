import * as assert from "node:assert/strict";
import { diffLineClass, exitCodeOf, hitCount, pickRenderer, splitMcpName, summarizeTool, type ToolItem, toolHeadline } from "../../../src/webview/tools";

function tool(overrides: Partial<ToolItem> & Pick<ToolItem, "name">): ToolItem {
	return { kind: "tool", id: "t1", args: {}, status: "done", startedAt: 1_000, ...overrides };
}

describe("pickRenderer", () => {
	it("maps known tool families", () => {
		assert.equal(pickRenderer("read"), "file");
		assert.equal(pickRenderer("write"), "file");
		assert.equal(pickRenderer("edit"), "file");
		assert.equal(pickRenderer("ast_edit"), "file");
		assert.equal(pickRenderer("grep"), "search");
		assert.equal(pickRenderer("glob"), "search");
		assert.equal(pickRenderer("ast_grep"), "search");
		assert.equal(pickRenderer("bash"), "shell");
		assert.equal(pickRenderer("eval"), "shell");
		assert.equal(pickRenderer("task"), "task");
		assert.equal(pickRenderer("lsp"), "lsp");
		assert.equal(pickRenderer("debug"), "lsp");
		assert.equal(pickRenderer("mcp__github_get_me"), "mcp");
		assert.equal(pickRenderer("job"), "job");
		assert.equal(pickRenderer("await"), "job");
		assert.equal(pickRenderer("cancel_job"), "job");
	});

	it("falls back to generic for unknown and odd names", () => {
		assert.equal(pickRenderer("brand_new_tool"), "generic");
		assert.equal(pickRenderer(""), "generic");
		assert.equal(pickRenderer("constructor"), "generic");
		assert.equal(pickRenderer("__proto__"), "generic");
	});
});

describe("summarizeTool", () => {
	it("uses common argument keys", () => {
		assert.equal(summarizeTool("read", { path: "src/a.ts" }), "src/a.ts");
		assert.equal(summarizeTool("grep", { pattern: "foo", path: "src" }), "foo · src");
		assert.equal(summarizeTool("bash", { command: "npm test" }), "npm test");
		assert.equal(summarizeTool("web_search", { query: "vscode api" }), "vscode api");
		assert.equal(summarizeTool("fetch", { url: "https://x.dev" }), "https://x.dev");
		assert.equal(summarizeTool("x", { agent: "scout" }), "scout");
	});

	it("summarizes task batches by name", () => {
		assert.equal(
			summarizeTool("task", { tasks: [{ name: "Alpha", task: "..." }, { agent: "scout", task: "..." }] }),
			"2 tasks: Alpha, scout",
		);
	});

	it("is single-line and bounded", () => {
		const s = summarizeTool("bash", { command: `echo a\necho b ${"x".repeat(300)}` });
		assert.ok(!s.includes("\n"));
		assert.ok(s.length <= 120, String(s.length));
		assert.ok(s.endsWith("…"));
	});

	it("never throws on unexpected args", () => {
		assert.equal(summarizeTool("x", undefined), "");
		assert.equal(summarizeTool("x", null), "");
		assert.equal(summarizeTool("x", "raw string"), "raw string");
		assert.equal(summarizeTool("x", 42), "42");
		assert.equal(summarizeTool("x", { nested: { deep: 1 } }), "");
		assert.equal(summarizeTool("x", { title: "only string" }), "only string");
		assert.equal(summarizeTool("x", { paths: ["a", "b"] }), "a, b");
	});
});

describe("tool helpers", () => {
	it("splits MCP names into server and tool", () => {
		assert.deepEqual(splitMcpName("mcp__github__get_me"), { server: "github", tool: "get_me" });
		assert.deepEqual(splitMcpName("mcp__context7_query_docs"), { server: "context7", tool: "query_docs" });
		assert.deepEqual(splitMcpName("mcp__solo"), { server: "solo", tool: "" });
	});

	it("classifies unified diff lines", () => {
		assert.equal(diffLineClass("+added"), "add");
		assert.equal(diffLineClass("-removed"), "del");
		assert.equal(diffLineClass("@@ -1 +1 @@"), "hunk");
		assert.equal(diffLineClass("+++ b/file"), "meta");
		assert.equal(diffLineClass("--- a/file"), "meta");
		assert.equal(diffLineClass(" ctx"), "ctx");
	});

	it("counts hits from details or result lines", () => {
		assert.equal(hitCount({ text: "a\nb\n\nc\n", isError: false }), 3);
		assert.equal(hitCount({ text: "a", isError: false, details: { matchCount: 7 } }), 7);
		assert.equal(hitCount(undefined), undefined);
	});

	it("reads exit codes defensively", () => {
		assert.equal(exitCodeOf({ text: "", isError: false, details: { exitCode: 2 } }), 2);
		assert.equal(exitCodeOf({ text: "", isError: false, details: "nope" }), undefined);
		assert.equal(exitCodeOf(undefined), undefined);
	});
});

describe("toolHeadline", () => {
	it("shows a finished read as name, path, check and duration", () => {
		const head = toolHeadline(tool({ name: "read", args: { path: "src/AuthService.cs" }, endedAt: 1_012, result: { text: "...", isError: false } }));
		assert.deepEqual(head, { name: "read", primary: "src/AuthService.cs", glyph: "✓", detail: "12ms" });
	});

	it("quotes search patterns and reports hits", () => {
		const head = toolHeadline(
			tool({ name: "grep", args: { pattern: "ValidateToken", path: "src" }, endedAt: 1_005, result: { text: "a", isError: false, details: { matchCount: 8 } } }),
		);
		assert.deepEqual(head, { name: "grep", primary: '"ValidateToken" in src', glyph: "✓", detail: "8 hits · 5ms" });
	});

	it("shows a failed command with exit code and the first error line", () => {
		const head = toolHeadline(
			tool({
				name: "bash",
				args: { command: "npm test" },
				status: "error",
				endedAt: 3_000,
				result: { text: "\n  npm ERR! test failed  \nmore detail", isError: true, details: { exitCode: 1 } },
			}),
		);
		assert.deepEqual(head, { name: "bash", primary: "npm test", glyph: "✗", detail: "exit 1 · 2.0s", error: "npm ERR! test failed" });
	});

	it("marks running tools without a duration", () => {
		const head = toolHeadline(tool({ name: "bash", args: { command: "sleep 10\necho done" }, status: "running", partial: "x" }));
		assert.deepEqual(head, { name: "bash", primary: "sleep 10 echo done", glyph: "…", detail: "" });
	});

	it("counts written lines", () => {
		const head = toolHeadline(tool({ name: "write", args: { path: "a.txt", content: "1\n2\n3" }, endedAt: 1_001 }));
		assert.equal(head.detail, "3 lines · 1ms");
		assert.equal(head.primary, "a.txt");
	});

	it("shows paths inside the working directory relative to it", () => {
		const read = toolHeadline(tool({ name: "read", args: { path: "/work/app/src/Auth.cs" }, endedAt: 1_001 }), "/work/app");
		assert.equal(read.primary, "src/Auth.cs");
		const grep = toolHeadline(tool({ name: "grep", args: { pattern: "x", path: "/work/app/src" }, endedAt: 1_001 }), "/work/app/");
		assert.equal(grep.primary, '"x" in src');
		const outside = toolHeadline(tool({ name: "read", args: { path: "/work/application/a.cs" }, endedAt: 1_001 }), "/work/app");
		assert.equal(outside.primary, "/work/application/a.cs");
		const windows = toolHeadline(tool({ name: "read", args: { path: "C:\\repo\\src\\a.cs" }, endedAt: 1_001 }), "C:\\repo");
		assert.equal(windows.primary, "src\\a.cs");
	});

	it("names MCP tools by server and tool", () => {
		const head = toolHeadline(tool({ name: "mcp__github__get_me", args: { query: "me" } }));
		assert.equal(head.name, "github › get_me");
		assert.equal(head.primary, "me");
	});

	it("falls back to the argument summary for unknown tools", () => {
		const head = toolHeadline(tool({ name: "brand_new_tool", args: { title: "something new" }, endedAt: 2_500 }));
		assert.deepEqual(head, { name: "brand_new_tool", primary: "something new", glyph: "✓", detail: "1.5s" });
	});

	it("never throws on odd arguments and bounds the error line", () => {
		assert.equal(toolHeadline(tool({ name: "read", args: null })).primary, "");
		assert.equal(toolHeadline(tool({ name: "grep", args: "raw" })).primary, '"raw"');
		const long = toolHeadline(tool({ name: "x", status: "error", result: { text: "e".repeat(500), isError: true } }));
		assert.ok(long.error && long.error.length <= 160 && long.error.endsWith("…"));
		assert.equal(toolHeadline(tool({ name: "x", status: "error" })).error, undefined);
	});
});
