import * as assert from "node:assert/strict";
import { documentListing } from "../../src/vscode/hostTools/format";
import { type LineEdit, planLineEdit, splitLines } from "../../src/vscode/hostTools/lineEdits";

/** Applies `edit` to `text` the way a text buffer would. */
function apply(text: string, edit: LineEdit): string {
	const lines = text.split(/(?<=\n)/);
	const offset = (line: number, character: number) => lines.slice(0, line).reduce((sum, l) => sum + l.length, 0) + character;
	return text.slice(0, offset(edit.startLine, edit.startCharacter)) + edit.text + text.slice(offset(edit.endLine, edit.endCharacter));
}

/** Plans the edit against `text` (lines separated by `\n`) and applies it. */
function replace(text: string, startLine: number, endLine: number, replacement: string, lineBreak = "\n"): string {
	const lines = splitLines(text);
	return apply(text, planLineEdit(lines.length, line => lines[line].length, startLine, endLine, replacement, lineBreak));
}

describe("host tool line edits", () => {
	const text = "a\nb\nc\nd";

	it("replaces a range of lines, ignoring one trailing line break of the replacement", () => {
		assert.equal(replace(text, 2, 3, "X\nY\n"), "a\nX\nY\nd");
		assert.equal(replace(text, 2, 2, "X\r\nY"), "a\nX\nY\nc\nd");
	});

	it("inserts before startLine when endLine is startLine - 1", () => {
		assert.equal(replace(text, 2, 1, "new"), "a\nnew\nb\nc\nd");
		assert.equal(replace(text, 1, 0, "top"), "top\na\nb\nc\nd");
	});

	it("appends when startLine is one past the last line", () => {
		assert.equal(replace(text, 5, 4, "e"), "a\nb\nc\nd\ne");
	});

	it("deletes the lines when the text is empty, including the last ones", () => {
		assert.equal(replace(text, 2, 3, ""), "a\nd");
		assert.equal(replace(text, 3, 4, ""), "a\nb");
		assert.equal(replace(text, 1, 4, ""), "");
	});

	it("replaces up to the end of the document without adding a line break", () => {
		assert.equal(replace(text, 4, 4, "z"), "a\nb\nc\nz");
		assert.equal(replace(text, 1, 4, "only"), "only");
	});

	it("joins the replacement with the document's line break", () => {
		assert.equal(replace("a\r\nb\r\nc", 2, 2, "x\ny", "\r\n"), "a\r\nx\r\ny\r\nc");
	});

	it("rejects ranges outside the document or ending before startLine - 1", () => {
		assert.throws(() => replace(text, 3, 1, "x"), { message: "endLine 1 must be at least startLine - 1 (2)." });
		assert.throws(() => replace(text, 6, 5, "x"), { message: "The document has 4 lines; startLine 6 is past the end (use 5 to append)." });
		assert.throws(() => replace(text, 2, 5, "x"), { message: "The document has 4 lines; endLine 5 is past the end." });
	});
});

describe("host tool document listing", () => {
	const lines = "abcdefghijkl".split("");
	const source = { path: "/w/a.ts", totalLines: lines.length, lineAt: (line: number) => lines[line], fromEditor: false };

	it("numbers the requested lines, padded to the widest number, under a header naming the source", () => {
		assert.equal(documentListing(source, 9, 10), "/w/a.ts (lines 9-10 of 12, disk)\n 9: i\n10: j");
		assert.equal(documentListing({ ...source, totalLines: 2, fromEditor: true }), "/w/a.ts (lines 1-2 of 2, editor buffer)\n1: a\n2: b");
	});

	it("reads to the end when endLine is omitted or past the end", () => {
		assert.equal(documentListing(source, 11), "/w/a.ts (lines 11-12 of 12, disk)\n11: k\n12: l");
		assert.equal(documentListing(source, 12, 40), "/w/a.ts (lines 12-12 of 12, disk)\n12: l");
	});

	it("rejects a startLine past the end", () => {
		assert.throws(() => documentListing(source, 13), { message: "The document has 12 lines; startLine 13 is past the end." });
	});

	it("splits text on every kind of line break and keeps a final empty line", () => {
		assert.deepEqual(splitLines("a\r\nb\rc\nd\n"), ["a", "b", "c", "d", ""]);
		assert.deepEqual(splitLines(""), [""]);
	});
});
