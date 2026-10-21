import * as assert from "node:assert/strict";
import { codeLines } from "../../../src/webview/codeLines";

/** Each line as its gutter number and `kind[*]:text` segments (`*` = marked). */
function shape(lines: ReturnType<typeof codeLines>): string[][] {
	return lines.map(line => [line.number, ...line.segments.map(segment => `${segment.kind}${segment.marked ? "*" : ""}:${segment.text}`)]);
}

describe("codeLines", () => {
	it("pads gutter numbers and turns a skipped range into one empty line", () => {
		assert.deepEqual(shape(codeLines("a\nb\nc", ["9", "10-40", "41"], undefined, undefined)), [[" 9", "text:a"], ["  "], ["41", "text:c"]]);
	});

	it("splits tokens that span lines so every line keeps its colors", () => {
		assert.deepEqual(shape(codeLines("/* a\nb */ x", undefined, "ts", undefined)), [
			["", "comment:/* a"],
			["", "comment:b */", "text: x"],
		]);
	});

	it("cuts tokens where search matches begin and end", () => {
		assert.deepEqual(shape(codeLines('let x = "foo";', undefined, "ts", /x = "f/g)), [
			["", "keyword:let", "text: ", "text*:x = ", 'string*:"f', 'string:oo"', "text:;"],
		]);
	});
});
