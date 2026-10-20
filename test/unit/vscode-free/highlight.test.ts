import * as assert from "node:assert/strict";
import { guessLanguage, normalizeLanguage, tokenize } from "../../../src/webview/highlight";

/** The colored tokens of `code` as `kind:text`. */
function colored(code: string, language: string | undefined): string[] {
	return tokenize(code, language)
		.filter(token => token.kind !== "text")
		.map(token => `${token.kind}:${code.slice(token.start, token.end)}`);
}

describe("tokenize", () => {
	it("covers the whole text in order", () => {
		const code = 'const a = "x"; // done\nlet b = 2;';
		const tokens = tokenize(code, "ts");
		assert.equal(tokens.map(token => code.slice(token.start, token.end)).join(""), code);
		tokens.slice(1).forEach((token, index) => assert.equal(token.start, tokens[index].end));
	});

	it("colors keywords, strings, numbers and comments of C-like languages", () => {
		assert.deepEqual(colored('public int X = 42; // answer\n/* note */ var s = "a\\"b";', "cs"), [
			"keyword:public",
			"keyword:int",
			"number:42",
			"comment:// answer",
			"comment:/* note */",
			"keyword:var",
			'string:"a\\"b"',
		]);
		assert.deepEqual(colored("const t = `x`;", "typescript"), ["keyword:const", "string:`x`"]);
		assert.deepEqual(colored("fn main() { let x = 1; }", "rs"), ["keyword:fn", "keyword:let", "number:1"]);
	});

	it("colors Python comments, triple-quoted strings and keywords", () => {
		assert.deepEqual(colored('def f():\n    """doc\n    more"""\n    return None  # nothing', "py"), [
			"keyword:def",
			'string:"""doc\n    more"""',
			"keyword:return",
			"keyword:None",
			"comment:# nothing",
		]);
	});

	it("colors shell commands, variables, raw quotes and comments after whitespace only", () => {
		assert.deepEqual(colored("sudo npm test $HOME 'a\\' # c\necho a#b", "bash"), [
			"keyword:sudo",
			"keyword:npm",
			"key:$HOME",
			"string:'a\\'",
			"comment:# c",
			"keyword:echo",
		]);
	});

	it("colors PowerShell keywords whatever their case", () => {
		assert.deepEqual(colored("Foreach ($x in $list) { }", "ps1"), ["keyword:Foreach", "key:$x", "keyword:in", "key:$list"]);
	});

	it("colors JSON keys apart from string values", () => {
		assert.deepEqual(colored('{"name": "omp", "ok": true, "n": -1}', "json"), ['key:"name"', 'string:"omp"', 'key:"ok"', "keyword:true", 'key:"n"', "number:-1"]);
	});

	it("colors YAML and INI keys at line starts, and quoted scalars", () => {
		assert.deepEqual(colored("name: 'omp'\n- step: run # go\nurl: a:b", "yml"), ["key:name", "string:'omp'", "key:step", "comment:# go", "key:url"]);
		assert.deepEqual(colored("[core]\nkey = true ; on", "toml"), ["key:key", "keyword:true", "comment:; on"]);
	});

	it("colors XML tags, attributes, values and comments", () => {
		assert.deepEqual(colored('<a href="x"><!-- c --></a>', "html"), ["tag:<a", "key:href", 'string:"x"', "tag:>", "comment:<!-- c -->", "tag:</a", "tag:>"]);
	});

	it("colors SQL keywords whatever their case", () => {
		assert.deepEqual(colored("Select * from t -- all", "sql"), ["keyword:Select", "keyword:from", "comment:-- all"]);
	});

	it("gives plain text one token and unknown languages strings and numbers only", () => {
		assert.deepEqual(tokenize("if x // y", "txt"), [{ start: 0, end: 9, kind: "text" }]);
		assert.deepEqual(colored('if "x" 1 // y', "brainfuck"), ['string:"x"', "number:1"]);
		assert.deepEqual(colored('if "x"', "constructor"), ['string:"x"']);
		assert.deepEqual(tokenize("", "ts"), []);
	});
});

describe("normalizeLanguage", () => {
	it("maps fence labels and file extensions to language families", () => {
		assert.equal(normalizeLanguage("tsx"), "typescript");
		assert.equal(normalizeLanguage("C#"), "csharp");
		assert.equal(normalizeLanguage("csproj"), "xml");
		assert.equal(normalizeLanguage("kt"), "c");
		assert.equal(normalizeLanguage("rb"), "python");
		assert.equal(normalizeLanguage("ts {1,3}"), "typescript");
	});

	it("knows nothing of plain text and unknown labels", () => {
		assert.equal(normalizeLanguage("md"), undefined);
		assert.equal(normalizeLanguage("cobol"), undefined);
		assert.equal(normalizeLanguage("toString"), undefined);
		assert.equal(normalizeLanguage(undefined), undefined);
	});
});

describe("guessLanguage", () => {
	it("recognizes JSON, XML and telltale lines", () => {
		assert.equal(guessLanguage('  {"a": 1}\n'), "json");
		assert.equal(guessLanguage("[1, 2]"), "json");
		assert.equal(guessLanguage('<?xml version="1.0"?>'), "xml");
		assert.equal(guessLanguage("using System;\nclass A {}"), "csharp");
		assert.equal(guessLanguage("import os\n"), "python");
		assert.equal(guessLanguage("export function f() {}"), "javascript");
		assert.equal(guessLanguage("package main\n"), "go");
	});

	it("does not guess prose or brackets that are not JSON", () => {
		assert.equal(guessLanguage("Found 3 files"), undefined);
		assert.equal(guessLanguage("[note] done"), undefined);
		assert.equal(guessLanguage(""), undefined);
	});
});
