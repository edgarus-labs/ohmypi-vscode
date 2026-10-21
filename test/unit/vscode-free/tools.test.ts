import * as assert from "node:assert/strict";
import {
	exitCodeOf,
	fileActions,
	fileLinkLabel,
	hitCount,
	outputView,
	pickRenderer,
	rendersMarkdown,
	searchPattern,
	shellInput,
	splitMcpName,
	splitSelector,
	summarizeTool,
	type ToolItem,
	toolHeadline,
	toolState,
} from "../../../src/webview/tools";
import { findMarks } from "../../../src/webview/toolText";

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
			summarizeTool("task", {
				tasks: [
					{ name: "Alpha", task: "..." },
					{ agent: "scout", task: "..." },
				],
			}),
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
	it("splits MCP names into server and tool at a double underscore", () => {
		assert.deepEqual(splitMcpName("mcp__github__get_me"), { server: "github", tool: "get_me" });
		assert.deepEqual(splitMcpName("mcp__solo"), { server: "solo", tool: "" });
	});

	it("keeps an MCP name whole when a single underscore cannot tell server from tool", () => {
		assert.deepEqual(splitMcpName("mcp__mcp_proxmox_gateway_proxmox_pools_list"), { server: "mcp_proxmox_gateway_proxmox_pools_list", tool: "" });
		assert.deepEqual(splitMcpName("mcp__context7_query_docs"), { server: "context7_query_docs", tool: "" });
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
	it("shows a finished read as name, path, check and duration, naming the file to open", () => {
		const head = toolHeadline(tool({ name: "read", args: { path: "src/AuthService.cs:50+20" }, endedAt: 1_012, result: { text: "...", isError: false } }));
		assert.deepEqual(head, {
			name: "read",
			primary: "src/AuthService.cs:50+20",
			glyph: "✓",
			state: "done",
			detail: "12ms",
			file: { path: "src/AuthService.cs", line: 50 },
		});
	});

	it("shows long tool durations in minutes and seconds, like the agents view", () => {
		const head = toolHeadline(tool({ name: "bash", args: { command: "make" }, endedAt: 1_000 + 125_000, result: { text: "", isError: false } }));
		assert.equal(head.detail, "2m 5s");
	});

	it("quotes search patterns and reports hits", () => {
		const head = toolHeadline(
			tool({
				name: "grep",
				args: { pattern: "ValidateToken", path: "src" },
				endedAt: 1_005,
				result: { text: "a", isError: false, details: { matchCount: 8 } },
			}),
		);
		assert.deepEqual(head, { name: "grep", primary: '"ValidateToken" in src', glyph: "✓", state: "done", detail: "8 hits · 5ms" });
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
		assert.deepEqual(head, { name: "bash", primary: "npm test", glyph: "✗", state: "error", detail: "exit 1 · 2.0s", error: "npm ERR! test failed" });
	});

	it("marks running tools without a duration", () => {
		const head = toolHeadline(tool({ name: "bash", args: { command: "sleep 10\necho done" }, status: "running", partial: "x" }));
		assert.deepEqual(head, { name: "bash", primary: "sleep 10 echo done", glyph: "…", state: "running", detail: "" });
	});

	it("shows no duration for a stored call that has no start time", () => {
		const head = toolHeadline(
			tool({ name: "bash", args: { command: "make" }, startedAt: 0, endedAt: 1_760_000_000_000, result: { text: "", isError: false } }),
		);
		assert.equal(head.detail, "");
	});

	it("does not throw for a call without a tool name", () => {
		const head = toolHeadline(tool({ name: undefined as unknown as string, args: { command: "make" }, endedAt: 1_001 }));
		assert.equal(head.state, "done");
		assert.match(head.error ?? "", /^Could not summarize this call: /);
	});

	it("counts written lines", () => {
		const head = toolHeadline(tool({ name: "write", args: { path: "a.txt", content: "1\n2\n3" }, endedAt: 1_001 }));
		assert.equal(head.detail, "3 lines · 1ms");
		assert.equal(head.primary, "a.txt");
		assert.equal(toolHeadline(tool({ name: "write", args: { path: "a.txt", content: "1\n2\n3\n" } })).detail, "3 lines");
		assert.equal(toolHeadline(tool({ name: "write", args: { path: "a.txt", content: "1\r\n2\r\n" } })).detail, "2 lines");
		assert.equal(toolHeadline(tool({ name: "write", args: { path: "a.txt", content: "1\n\n" } })).detail, "2 lines");
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

	it("keeps the working directory itself in full", () => {
		const primary = (command: string) => toolHeadline(tool({ name: "bash", args: { command } }), "/home/u/proj").primary;
		assert.equal(primary("rm -rf /home/u/proj/"), "rm -rf /home/u/proj/");
		assert.equal(primary("cd /home/u/proj/ && make"), "cd /home/u/proj/ && make");
		assert.equal(primary("cd /home/u/proj/;make"), "cd /home/u/proj/;make");
		assert.equal(primary('ls "/home/u/proj/"'), 'ls "/home/u/proj/"');
		assert.equal(primary("cat /home/u/proj/a.txt /home/u/proj/*"), "cat a.txt *");
		assert.equal(fileLinkLabel("C:\\repo\\", undefined, "C:\\repo"), "C:\\repo\\");
	});

	it("names MCP tools by server and tool", () => {
		const head = toolHeadline(tool({ name: "mcp__github__get_me", args: { query: "me" } }));
		assert.equal(head.name, "github › get_me");
		assert.equal(head.primary, "me");
	});

	it("falls back to the argument summary for unknown tools", () => {
		const head = toolHeadline(tool({ name: "brand_new_tool", args: { title: "something new" }, endedAt: 2_500 }));
		assert.deepEqual(head, { name: "brand_new_tool", primary: "something new", glyph: "✓", state: "done", detail: "1.5s" });
	});

	it("never throws on odd arguments and bounds the error line", () => {
		assert.equal(toolHeadline(tool({ name: "read", args: null })).primary, "");
		assert.equal(toolHeadline(tool({ name: "grep", args: "raw" })).primary, '"raw"');
		const long = toolHeadline(tool({ name: "x", status: "error", result: { text: "e".repeat(500), isError: true } }));
		assert.ok(long.error && long.error.length <= 160 && long.error.endsWith("…"));
		assert.equal(toolHeadline(tool({ name: "x", status: "error" })).error, undefined);
	});

	it("does not count the lines of a failed search's error as hits", () => {
		const head = toolHeadline(
			tool({
				name: "grep",
				status: "error",
				args: { pattern: "x(" },
				endedAt: 1_002,
				result: { text: "Error: invalid regex\nUnterminated group", isError: true },
			}),
		);
		assert.equal(head.detail, "2ms");
		assert.equal(head.error, "Error: invalid regex");
	});

	it("reports why a headline could not be built", () => {
		const details = new Proxy(
			{},
			{
				get() {
					throw new Error("boom");
				},
			},
		);
		const head = toolHeadline(tool({ name: "read", args: {}, result: { text: "", isError: false, details } }));
		assert.deepEqual(head, { name: "read", primary: "", glyph: "✓", state: "done", detail: "", error: "Could not summarize this call: boom" });
	});
});

describe("fileLinkLabel", () => {
	it("shows paths under the working directory relative to it, with the line", () => {
		assert.equal(fileLinkLabel("D:\\dev\\repo\\src\\a.ts", 12, "D:\\dev\\repo"), "src\\a.ts:12");
		assert.equal(fileLinkLabel("/home/me/repo/src/a.ts", undefined, "/home/me/repo/"), "src/a.ts");
	});

	it("matches a Windows working directory whatever the drive letter case and separators", () => {
		assert.equal(fileLinkLabel("d:\\dev\\repo\\src\\a.ts", 3, "D:\\dev\\repo"), "src\\a.ts:3");
		assert.equal(fileLinkLabel("D:/dev/repo/src/a.ts", undefined, "D:\\dev\\repo"), "src/a.ts");
		assert.equal(fileLinkLabel("D:\\dev\\repo\\src\\a.ts", undefined, "d:/dev/repo"), "src\\a.ts");
	});

	it("keeps POSIX paths case-sensitive", () => {
		assert.equal(fileLinkLabel("/Home/me/repo/a.ts", undefined, "/home/me/repo"), "/Home/me/repo/a.ts");
	});

	it("keeps paths outside the working directory absolute", () => {
		assert.equal(fileLinkLabel("/etc/hosts", 3, "/home/me/repo"), "/etc/hosts:3");
		assert.equal(fileLinkLabel("src/a.ts", undefined, undefined), "src/a.ts");
	});
});

describe("splitSelector", () => {
	it("takes the first line of a single range", () => {
		assert.deepEqual(splitSelector("src/a.ts:12"), { path: "src/a.ts", line: 12 });
		assert.deepEqual(splitSelector("src/a.ts:12-40"), { path: "src/a.ts", line: 12 });
		assert.deepEqual(splitSelector("src/a.ts:50+150"), { path: "src/a.ts", line: 50 });
	});

	it("strips comma-joined ranges, tail counts and mode suffixes", () => {
		assert.deepEqual(splitSelector("src/a.ts:5-16,960-973"), { path: "src/a.ts", line: 5 });
		assert.deepEqual(splitSelector("src/a.ts:-60"), { path: "src/a.ts" });
		assert.deepEqual(splitSelector("src/a.ts:raw"), { path: "src/a.ts" });
		assert.deepEqual(splitSelector("src/a.ts:5-16:raw"), { path: "src/a.ts", line: 5 });
		assert.deepEqual(splitSelector("src/a.ts:raw:2-4"), { path: "src/a.ts", line: 2 });
		assert.deepEqual(splitSelector("C:\\repo\\a.ts:7"), { path: "C:\\repo\\a.ts", line: 7 });
	});

	it("strips the conflicts, image and video time selectors", () => {
		assert.deepEqual(splitSelector("src/a.ts:conflicts"), { path: "src/a.ts" });
		assert.deepEqual(splitSelector("media/icon.svg:img"), { path: "media/icon.svg" });
		assert.deepEqual(splitSelector("clip.mp4:1h5m42s"), { path: "clip.mp4" });
		assert.deepEqual(splitSelector("clip.mp4:90s"), { path: "clip.mp4" });
	});

	it("leaves plain paths alone", () => {
		assert.deepEqual(splitSelector("C:\\repo\\a.ts"), { path: "C:\\repo\\a.ts" });
		assert.deepEqual(splitSelector("notes"), { path: "notes" });
	});
});

describe("toolState", () => {
	it("tells a job started in the background from a finished call", () => {
		const started = tool({ name: "bash", endedAt: 1_005, result: { text: "started", isError: false, details: { async: { state: "running", jobId: "j1" } } } });
		assert.equal(toolState(started), "background");
		assert.equal(toolState({ ...started, result: { text: "", isError: false, details: { async: { state: "done" } } } }), "done");
		assert.equal(toolState({ ...started, status: "running" }), "running");
		assert.equal(toolState({ ...started, result: { ...started.result, text: "", isError: true } }), "error");
		assert.equal(toolState(tool({ name: "x", status: "unresolved" })), "unresolved");
	});

	it("shows a background job's headline as still going, without a duration", () => {
		const head = toolHeadline(
			tool({
				name: "bash",
				args: { command: "npm run watch" },
				endedAt: 1_005,
				result: { text: "started", isError: false, details: { exitCode: 0, async: { state: "running" } } },
			}),
		);
		assert.deepEqual(head, { name: "bash", primary: "npm run watch", glyph: "…", state: "background", detail: "in background" });
	});
});

describe("shell rows", () => {
	it("heads a described call with its description and shows the command as input", () => {
		const item = tool({ name: "bash", args: { command: "npm test", i: "Running unit tests", timeout: 60 } });
		assert.equal(toolHeadline(item).primary, "Running unit tests");
		assert.deepEqual(shellInput(item), { command: { text: "npm test", language: "bash" }, parameters: "timeout: 60" });
	});

	it("keeps a short undescribed command in the header only", () => {
		assert.equal(shellInput(tool({ name: "bash", args: { command: "ls -la" } })), undefined);
		assert.deepEqual(shellInput(tool({ name: "bash", args: { command: "ls", cwd: "src" } })), { parameters: "cwd: src" });
	});

	it("shows a command that does not fit the header, in the eval language", () => {
		assert.deepEqual(shellInput(tool({ name: "bash", args: { command: "cd src\nls" } })), { command: { text: "cd src\nls", language: "bash" } });
		assert.deepEqual(shellInput(tool({ name: "eval", args: { code: "x".repeat(130), language: "py" } })), {
			command: { text: "x".repeat(130), language: "py" },
			parameters: "language: py",
		});
	});

	it("shows shell output without OMP's timing and exit lines", () => {
		const item = tool({ name: "bash", args: { command: "make" }, result: { text: "built\n\nWall time: 2s\nCommand exited with code 0\n", isError: false } });
		assert.deepEqual(outputView(item, true), { kind: "code", shown: "built", copy: item.result?.text, language: undefined, mark: undefined });
	});
});

describe("outputView", () => {
	it("strips fences and colors the result in the first fence's language", () => {
		const text = "```json\n{\n}\n```";
		const view = outputView(tool({ name: "mcp__x__y", result: { text, isError: false } }));
		assert.deepEqual(view, { kind: "code", shown: "{\n}", copy: text, language: "json", mark: undefined });
	});

	it("pretty-prints one line of JSON for display and copies the original", () => {
		const view = outputView(tool({ name: "fetch", result: { text: '{"a":[1,2]}', isError: false } }));
		assert.deepEqual(view, { kind: "code", shown: '{\n  "a": [\n    1,\n    2\n  ]\n}', copy: '{"a":[1,2]}', language: "json", mark: undefined });
	});

	it("takes the language from the file a file tool read, else guesses it", () => {
		const language = (item: ToolItem) => {
			const view = outputView(item);
			return view?.kind === "code" ? view.language : view?.kind;
		};
		assert.equal(language(tool({ name: "read", args: { path: "src/App.CS:10" }, result: { text: "1:x", isError: false } })), "cs");
		assert.equal(language(tool({ name: "x", result: { text: "import os\nprint(1)", isError: false } })), "python");
	});

	it("renders output that looks like a diff as a diff, unless the call failed", () => {
		const text = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b";
		assert.deepEqual(outputView(tool({ name: "bash", result: { text, isError: false } }), true), { kind: "diff", text });
		assert.equal(outputView(tool({ name: "bash", result: { text, isError: true } }), true)?.kind, "code");
	});

	it("shows running output as it comes, and nothing before it comes", () => {
		assert.deepEqual(outputView(tool({ name: "bash", status: "running", partial: "```\nhalf" }), true), {
			kind: "code",
			shown: "```\nhalf",
			copy: "```\nhalf",
			language: undefined,
			mark: undefined,
		});
		assert.equal(outputView(tool({ name: "bash", status: "running" }), true), undefined);
	});
});

describe("rendersMarkdown", () => {
	const md = "# Title\n\nBody text";

	it("renders reads of Markdown files and Markdown-looking MCP or generic results", () => {
		assert.equal(rendersMarkdown(tool({ name: "read", args: { path: "docs/README.md:1-20" }, result: { text: "1:hi", isError: false } })), true);
		assert.equal(rendersMarkdown(tool({ name: "read", args: { path: "notes.markdown" }, result: { text: "plain", isError: false } })), true);
		assert.equal(rendersMarkdown(tool({ name: "read", args: { path: "skill://x" }, result: { text: md, isError: false } })), true);
		assert.equal(rendersMarkdown(tool({ name: "mcp__docs__fetch", result: { text: md, isError: false } })), true);
		assert.equal(rendersMarkdown(tool({ name: "web_search", result: { text: md, isError: false } })), true);
	});

	it("never renders file, search or shell results, plain text or errors as Markdown", () => {
		assert.equal(rendersMarkdown(tool({ name: "read", args: { path: "a.ts" }, result: { text: md, isError: false } })), false);
		assert.equal(rendersMarkdown(tool({ name: "grep", result: { text: md, isError: false } })), false);
		assert.equal(rendersMarkdown(tool({ name: "bash", result: { text: md, isError: false } })), false);
		assert.equal(rendersMarkdown(tool({ name: "web_search", result: { text: "just text", isError: false } })), false);
		assert.equal(rendersMarkdown(tool({ name: "mcp__docs__fetch", result: { text: md, isError: true } })), false);
	});
});

describe("searchPattern", () => {
	it("compiles a search call's pattern, ignoring case when the call asks", () => {
		const pattern = searchPattern(tool({ name: "grep", args: { pattern: "^foo\\d", case: false } }));
		assert.equal(pattern?.source, "^foo\\d");
		assert.equal(pattern?.flags, "gim");
		assert.equal(searchPattern(tool({ name: "grep", args: { pattern: "x" } }))?.flags, "gm");
	});

	it("falls back to the literal text of an invalid pattern", () => {
		const pattern = searchPattern(tool({ name: "ast_grep", args: { pattern: "foo(" } }));
		assert.ok(pattern?.test("call foo(1)"));
	});

	const grep = (pattern: string) => searchPattern(tool({ name: "grep", args: { pattern } }));
	const literal = (pattern: string) => pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	/** Patterns a backtracking regex can spend super-linear time on: quantified groups, backreferences, alternation in a group, several quantifiers, or a long pattern. */
	const RUNAWAY = [
		"(a+)+$",
		"(\\w*)*x",
		"(ab)+c",
		"(\\w+\\s?)+:",
		"(a|aa)+b",
		"((a+))+b",
		"(.*a){12}",
		"(\\d+\\.?)+",
		"(\\w+,?)+",
		"(?:ab)?c",
		"(?=a)*b",
		"(\\w+)\\s\\1",
		"(?<w>\\w)\\k<w>",
		"(a|a)(a|a)(a|a)b",
		"a*a*x",
		".*.*=",
		"\\w+\\s?\\w+:",
		"\\w*a{900}b",
		"\\d{1,3}\\.\\d{1,3}",
		"a?a?a?b",
		`\\w*${"[a]".repeat(40)}b`,
	];
	/** Patterns whose work per position stays bounded: one repeating quantifier, up to two optional ones, alternation at the top level only. */
	const BOUNDED = [
		"^foo\\d",
		"foo\\s+bar",
		"https?://\\S+",
		"TODO|FIXME",
		"export (?:const) \\w+",
		"(?<=a)b+",
		"[(|)+*]+x",
		"\\(x\\)+",
		"colou?r",
		".*x",
		"\\w+\\s?:",
		"a?a?a+x",
		"x{2}",
	];

	it("marks a pattern whose backtracking could outgrow the text as literal text", () => {
		for (const pattern of RUNAWAY) assert.equal(grep(pattern)?.source, literal(pattern), pattern);
	});

	it("compiles a pattern whose backtracking stays bounded", () => {
		for (const pattern of BOUNDED) assert.equal(grep(pattern)?.source, new RegExp(pattern).source, pattern);
	});

	it("marks the largest open result quickly whatever the pattern", () => {
		const lines = ["a".repeat(5000), "a".repeat(999), "1".repeat(999), "1.".repeat(499), "a,".repeat(499), "a ".repeat(499), "a".repeat(29)];
		let text = "";
		while (text.length < 200_000) text += `${lines.join("\n")}\n`;
		for (const pattern of [...RUNAWAY, ...BOUNDED]) {
			const mark = grep(pattern);
			assert.ok(mark);
			const started = performance.now();
			findMarks(text, mark);
			const elapsed = performance.now() - started;
			assert.ok(elapsed < 1000, `${pattern} took ${Math.round(elapsed)} ms`);
		}
	});

	it("marks nothing for other tools or calls without a pattern", () => {
		assert.equal(searchPattern(tool({ name: "bash", args: { pattern: "x" } })), undefined);
		assert.equal(searchPattern(tool({ name: "glob", args: { paths: ["a"] } })), undefined);
	});
});

describe("fileActions", () => {
	const done = (details: unknown, args: unknown, name = "edit"): ToolItem =>
		tool({ name, args, endedAt: 1_001, result: { text: "ok", isError: false, details } });

	it("offers one Diff for the header's file without repeating its link", () => {
		assert.deepEqual(fileActions(done({ diff: "@@ -1 +1 @@\n-a\n+b" }, { path: "/w/src/a.ts" }), "/w"), [{ kind: "diff", path: "/w/src/a.ts", label: "Diff" }]);
	});

	it("links and diffs every file of a multi-file edit", () => {
		assert.deepEqual(fileActions(done(undefined, { edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }), "/w"), [
			{ kind: "open", path: "src/a.ts", line: undefined },
			{ kind: "diff", path: "src/a.ts", label: "Diff src/a.ts" },
			{ kind: "open", path: "src/b.ts", line: undefined },
			{ kind: "diff", path: "src/b.ts", label: "Diff src/b.ts" },
		]);
	});

	it("offers Diff outside the working directory only when the tool recorded the old text", () => {
		const actions = fileActions(done({ perFileResults: [{ path: "/etc/a.conf", oldText: "x" }, { path: "/etc/b.conf" }] }, {}), "/w");
		assert.deepEqual(
			actions.map(action => `${action.kind} ${action.path}`),
			["open /etc/a.conf", "diff /etc/a.conf", "open /etc/b.conf"],
		);
	});

	it("counts a file once however the call names it", () => {
		const actions = fileActions(done({ path: "/w/src/a.ts" }, { path: "src/a.ts" }), "/w");
		assert.deepEqual(actions, [{ kind: "diff", path: "src/a.ts", label: "Diff" }]);
	});

	it("offers no Diff for reads and running calls", () => {
		assert.deepEqual(fileActions(done(undefined, { path: "/w/a.ts" }, "read"), "/w"), []);
		assert.deepEqual(fileActions({ ...done(undefined, { path: "/w/a.ts" }), status: "running" }, "/w"), []);
	});

	it("offers no Diff for a failed call that recorded no diff", () => {
		const failed: ToolItem = { ...done(undefined, { path: "/w/a.ts" }, "write"), status: "error", result: { text: "EACCES", isError: true } };
		assert.deepEqual(fileActions(failed, "/w"), []);
		const partly = { ...failed, name: "edit", result: { text: "1 of 2 edits failed", isError: true, details: { diff: "-a\n+b" } } };
		assert.deepEqual(fileActions(partly, "/w"), [{ kind: "diff", path: "/w/a.ts", label: "Diff" }]);
	});
});
