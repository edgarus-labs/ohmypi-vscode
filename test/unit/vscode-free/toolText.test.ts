import * as assert from "node:assert/strict";
import {
	changedSpans,
	cutTo,
	diffLineClasses,
	findMarks,
	flatArgs,
	looksLikeDiff,
	looksLikeMarkdown,
	prettyJson,
	splitLineNumbers,
	stripFences,
	stripShellTrailer,
} from "../../../src/webview/toolText";

describe("cutTo", () => {
	it("keeps text within both limits and cuts the rest to whole lines, then characters", () => {
		assert.equal(cutTo("a\nb", 5, 100), "a\nb");
		assert.equal(cutTo("1\n2\n3\n4\n5\n6\n7", 5, 100), "1\n2\n3\n4\n5");
		assert.equal(cutTo("x".repeat(50), 5, 10), "x".repeat(10));
	});
});

describe("flatArgs", () => {
	it("shows an object as name: value lines with strings bare and later lines indented", () => {
		assert.equal(flatArgs({ path: "a.ts", content: "one\r\ntwo", n: 2, opts: { a: [1] } }), 'path: a.ts\ncontent: one\n  two\nn: 2\nopts: {"a":[1]}');
	});

	it("shows anything else as indented JSON", () => {
		assert.equal(flatArgs([1, 2]), "[\n  1,\n  2\n]");
		assert.equal(flatArgs("raw"), '"raw"');
	});
});

describe("stripShellTrailer", () => {
	it("drops OMP's trailing timing and exit lines and blank lines around them", () => {
		assert.equal(stripShellTrailer("ok\r\ndone\n\nWall time: 1.2 seconds\nCommand exited with code 1\n\n"), "ok\ndone");
	});

	it("keeps lines of that shape inside the output", () => {
		assert.equal(stripShellTrailer("Wall time: 3s\nreal output"), "Wall time: 3s\nreal output");
	});
});

describe("stripFences", () => {
	it("removes every fence line and takes the first labeled fence's language", () => {
		assert.deepEqual(stripFences("Result:\n```\nplain\n```\n```ts\nconst a = 1;\n```\n```py\nx\n```"), {
			text: "Result:\nplain\nconst a = 1;\nx",
			language: "ts",
		});
	});

	it("leaves text without fences alone", () => {
		assert.deepEqual(stripFences("a\nb"), { text: "a\nb", language: undefined });
	});
});

describe("prettyJson", () => {
	it("indents one line of JSON, copying strings and numbers verbatim", () => {
		assert.equal(prettyJson(' {"a":1.50,"b":[true,{}],"c":"x, \\"y\\": [z]"} '), '{\n  "a": 1.50,\n  "b": [\n    true,\n    {}\n  ],\n  "c": "x, \\"y\\": [z]"\n}');
	});

	it("leaves invalid, multi-line and scalar JSON alone", () => {
		assert.equal(prettyJson('{"a":}'), undefined);
		assert.equal(prettyJson('{\n"a": 1}'), undefined);
		assert.equal(prettyJson('"text"'), undefined);
		assert.equal(prettyJson("12"), undefined);
		assert.equal(prettyJson(`${"[".repeat(70)}${"]".repeat(70)}`), undefined);
	});
});

describe("splitLineNumbers", () => {
	it("splits a read listing into its header, gutter and code", () => {
		assert.deepEqual(splitLineNumbers("[src/a.ts#1A2B]\n1:import x;\n*2:const y = 1;\n3:\n"), {
			header: "[src/a.ts#1A2B]",
			numbers: ["1", "*2", "3"],
			code: "import x;\nconst y = 1;\n",
		});
	});

	it("keeps elided ranges and gaps between numbered lines", () => {
		assert.deepEqual(splitLineNumbers("10:a\n11-40:b\n…\n90:c"), { header: undefined, numbers: ["10", "11-40", "", "90"], code: "a\nb\n…\nc" });
	});

	it("refuses text whose numbers do not climb or that is mostly unnumbered", () => {
		assert.equal(splitLineNumbers("5:a\n3:b"), undefined);
		assert.equal(splitLineNumbers("note: one\nplain\nplain\nplain"), undefined);
		assert.equal(splitLineNumbers("plain text"), undefined);
		assert.equal(splitLineNumbers("[only a header#1]"), undefined);
	});
});

describe("looksLikeMarkdown", () => {
	it("needs an ATX heading and another non-blank line", () => {
		assert.equal(looksLikeMarkdown("# Title\n\nSome text"), true);
		assert.equal(looksLikeMarkdown("# Title"), false);
		assert.equal(looksLikeMarkdown("#hashtag\ntext"), false);
		assert.equal(looksLikeMarkdown("plain\ntext"), false);
	});
});

describe("looksLikeDiff", () => {
	it("recognizes git headers and hunk lines", () => {
		assert.equal(looksLikeDiff("diff --git a/x b/x\nindex 1"), true);
		assert.equal(looksLikeDiff("text\n@@ -1,2 +1,2 @@\n-a\n+b"), true);
		assert.equal(looksLikeDiff("+ added\n- removed"), false);
	});
});

describe("changedSpans", () => {
	it("marks the changed words of paired removed and added lines", () => {
		const lines = ["@@ -1 +1 @@", " same", "-const total = 1;", "+const sum = 1;", "-gone"];
		assert.deepEqual(changedSpans(lines), [undefined, undefined, { start: 6, length: 5 }, { start: 6, length: 3 }, undefined]);
	});

	it("leaves a pair with nothing in common and unpaired lines unmarked", () => {
		assert.deepEqual(changedSpans(["-abc", "+xyz", "+extra"]), [undefined, undefined, undefined]);
	});

	it("marks only the inserted part when one side has nothing extra", () => {
		assert.deepEqual(changedSpans(["-f(a)", "+f(a, b)"]), [undefined, { start: 3, length: 3 }]);
	});
});

describe("findMarks", () => {
	it("finds every non-empty match, case-insensitively when asked", () => {
		assert.deepEqual(findMarks("Foo foo\nfoo", /foo/gim), [
			{ start: 0, end: 3 },
			{ start: 4, end: 7 },
			{ start: 8, end: 11 },
		]);
		assert.deepEqual(findMarks("aaa", /x*/g), []);
	});

	it("stops after a bounded number of matches", () => {
		assert.equal(findMarks("a\n".repeat(20_000), /a/g).length, 10_000);
	});

	it("matches within each line and its first 1000 columns, leaving out a match the cut ends", () => {
		const line = `${"x".repeat(990)}foo${"y".repeat(5)}foo${"z".repeat(10)}`;
		assert.deepEqual(findMarks(`${line}\nfoo`, /foo/g), [
			{ start: 990, end: 993 },
			{ start: line.length + 1, end: line.length + 4 },
		]);
		assert.deepEqual(findMarks("a".repeat(1500), /a+$/gm), []);
		assert.deepEqual(findMarks("a\nb", /a\sb/g), []);
		assert.deepEqual(findMarks("ab\nab", /b$/gm), [
			{ start: 1, end: 2 },
			{ start: 4, end: 5 },
		]);
	});

	it("takes time linear in the text for a pattern with one quantifier", () => {
		const started = performance.now();
		findMarks("a".repeat(200_000), /.*x/gm);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < 500, `took ${Math.round(elapsed)} ms`);
	});
});

describe("diffLineClasses", () => {
	it("classifies unified diff lines", () => {
		assert.deepEqual(diffLineClasses(["--- a/file", "+++ b/file", "@@ -1 +1 @@", " ctx", "-removed", "+added"]), ["meta", "meta", "hunk", "ctx", "del", "add"]);
	});

	it("treats --- and +++ as a file header only as a pair, so removed `--` and added `++` lines keep their color", () => {
		assert.deepEqual(diffLineClasses(["@@ -1,2 +1,2 @@", "--- old comment", "-x", "+++i;", "+y"]), ["hunk", "del", "del", "add", "add"]);
		assert.deepEqual(diffLineClasses(["---", " key: 1"]), ["del", "ctx"]);
	});
});
