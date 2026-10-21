import * as assert from "node:assert/strict";
import { formatPrompt, splitUserMessage } from "../../../src/shared/prompt";
import { type EditorContextData, formatEditorContext } from "../../../src/vscode/editorContextFormat";

const base: EditorContextData = {
	workspaceFolders: ["/work/repo"],
	openEditors: [],
	diagnostics: [],
	workspaceDiagnostics: { errors: 0, warnings: 0 },
};

describe("formatEditorContext", () => {
	it("formats active file, cursor, selection, diagnostics and git changes", () => {
		const text = formatEditorContext({
			...base,
			activeFile: { path: "src/a.ts", languageId: "typescript", line: 12, column: 4 },
			selection: { text: "const x = 1;", startLine: 12, endLine: 12 },
			openEditors: ["src/b.ts"],
			diagnostics: [{ severity: "error", line: 3, message: "Cannot find name 'y'.", source: "ts" }],
			workspaceDiagnostics: { errors: 2, warnings: 5 },
			gitChanges: ["src/a.ts", "README.md"],
		});
		assert.equal(
			text,
			[
				"<editor-context>",
				"workspace: /work/repo",
				"active file: src/a.ts (typescript), cursor 12:4",
				"selection (lines 12-12):",
				"```typescript",
				"const x = 1;",
				"```",
				"open editors: src/b.ts",
				"diagnostics in active file:",
				"- error L3: Cannot find name 'y'. [ts]",
				"workspace diagnostics: 2 errors, 5 warnings",
				"git changes: src/a.ts, README.md",
				"</editor-context>",
			].join("\n"),
		);
	});

	it("caps selection to 8 KB, open editors to 10 and diagnostics to 20", () => {
		const text = formatEditorContext({
			...base,
			activeFile: { path: "a.txt", languageId: "plaintext", line: 1, column: 1 },
			selection: { text: "x".repeat(9000), startLine: 1, endLine: 1 },
			openEditors: Array.from({ length: 15 }, (_, i) => `f${i}.ts`),
			diagnostics: Array.from({ length: 25 }, (_, i) => ({ severity: "warning" as const, line: i + 1, message: `w${i}` })),
		});
		assert.ok(text.includes(`${"x".repeat(8192)}\n[selection truncated]`));
		assert.ok(!text.includes("x".repeat(8193)));
		assert.ok(text.includes("f9.ts"));
		assert.ok(!text.includes("f10.ts"));
		assert.ok(text.includes("(+5 more)"));
		assert.ok(text.includes("- warning L20: w19"));
		assert.ok(!text.includes("w20"));
		assert.ok(text.includes("(+5 more diagnostics)"));
	});

	it("caps each diagnostic message", () => {
		const text = formatEditorContext({ ...base, diagnostics: [{ severity: "error", line: 1, message: "y".repeat(1000), source: "ts" }] });
		assert.ok(text.includes(`- error L1: ${"y".repeat(299)}… [ts]`), text);
		assert.ok(!text.includes("y".repeat(300)));
	});

	it("survives a closing tag inside its content when sent in a prompt", () => {
		const tag = "</editor-context>";
		const editorContext = formatEditorContext({
			...base,
			activeFile: { path: `${tag}.md`, languageId: "markdown", line: 1, column: 1 },
			selection: { text: `before ${tag} after`, startLine: 1, endLine: 1 },
			diagnostics: [{ severity: "error", line: 1, message: `bad ${tag}` }],
		});
		const prompt = formatPrompt({ editorContext, text: "question", pasted: [], files: [] });
		assert.equal(prompt.indexOf(tag), prompt.indexOf("\n\nquestion") - tag.length, prompt);
		assert.deepEqual(splitUserMessage(prompt), { editorContext, text: "question", pasted: [], files: [] });
	});

	it("uses a longer fence when the selection contains backticks", () => {
		const text = formatEditorContext({
			...base,
			activeFile: { path: "a.md", languageId: "markdown", line: 1, column: 1 },
			selection: { text: "```js\nx\n```", startLine: 1, endLine: 3 },
		});
		assert.ok(text.includes("````markdown\n```js\nx\n```\n````"), text);
	});

	it("omits empty sections", () => {
		assert.equal(formatEditorContext(base), "<editor-context>\nworkspace: /work/repo\n</editor-context>");
	});
});
