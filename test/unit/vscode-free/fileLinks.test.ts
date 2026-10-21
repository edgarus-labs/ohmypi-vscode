import * as assert from "node:assert/strict";
import { fileLinkTarget } from "../../../src/webview/fileLinks";

describe("fileLinkTarget", () => {
	const accepted: Array<[string, { path: string; line?: number }]> = [
		["src/extension.ts", { path: "src/extension.ts" }],
		["./a.ts", { path: "./a.ts" }],
		["../a", { path: "../a" }],
		["/etc/hosts", { path: "/etc/hosts" }],
		["d:/x/a.ts", { path: "d:/x/a.ts" }],
		["d:/x/a.ts:12", { path: "d:/x/a.ts", line: 12 }],
		["C:\\x\\a.ts", { path: "C:\\x\\a.ts" }],
		["C:\\x\\a.ts:7:3", { path: "C:\\x\\a.ts", line: 7 }],
		["\\\\server\\share\\a.txt", { path: "\\\\server\\share\\a.txt" }],
		["/a.ts", { path: "/a.ts" }],
		["~/x", { path: "~/x" }],
		["extension.ts", { path: "extension.ts" }],
		["package.json", { path: "package.json" }],
		["README.md#L12", { path: "README.md", line: 12 }],
		["src/a.ts#L5-L9", { path: "src/a.ts", line: 5 }],
		["vscode.test.ts:40", { path: "vscode.test.ts", line: 40 }],
		["test/unit/.eslintrc.json", { path: "test/unit/.eslintrc.json" }],
		["src/a.ts:0", { path: "src/a.ts" }],
	];
	for (const [text, target] of accepted) {
		it(`links ${text}`, () => {
			assert.deepEqual(fileLinkTarget(text), target);
		});
	}

	const rejected = [
		"npm",
		"omp.extraArgs",
		"omp.executablePath",
		"console.log",
		"process.env",
		"array.map",
		"JSON.parse",
		"this.state",
		"omp.model",
		"https://x.y/a.ts",
		"file:///c:/a.ts",
		"vscode://file/a.ts",
		"javascript:alert(1)",
		"mailto:a@b.ts",
		"//cdn.example/a.js",
		"and/or",
		"~",
		"/rules",
		"/",
		"..",
		"feature/branch",
		"src/webview",
		"src/webview/",
		"src/**/*.ts",
		"a.ts b.ts",
		"npm run build",
		"",
		".gitignore",
		"a<b",
		"v1.2.3",
		"1.5",
	];
	for (const text of rejected) {
		it(`does not link ${JSON.stringify(text)}`, () => {
			assert.equal(fileLinkTarget(text), undefined);
		});
	}
});
