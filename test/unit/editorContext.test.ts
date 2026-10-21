import * as assert from "node:assert/strict";
import * as path from "node:path";
import { editorContextBlock } from "../../src/vscode/EditorContext";
import { memoryLogger } from "./helpers";
import { DiagnosticSeverity, Position, Range, stub, TabInputText, Uri, window, workspace } from "./stubs/vscode";

/** Text editor over `text` (single line) with the cursor at `start` and `end` selected. */
function editor(uri: Uri, text: string, start: number, end: number) {
	const position = (offset: number) => new Position(0, offset);
	const selection = Object.assign(new Range(position(start), position(end)), { active: position(end), isEmpty: start === end });
	return {
		selection,
		document: {
			uri,
			languageId: "typescript",
			offsetAt: (at: Position) => at.character,
			positionAt: position,
			getText: (range: Range) => text.slice(range.start.character, range.end.character),
		},
	};
}

describe("editorContextBlock", () => {
	const root = path.resolve("/work/repo");
	const inside = (name: string) => Uri.file(path.join(root, name));

	beforeEach(() => {
		stub.reset();
		workspace.workspaceFolders = [{ uri: Uri.file(root), name: "repo", index: 0 }];
		stub.on("workspace.getWorkspaceFolder", (uri: Uri) =>
			uri.scheme === "file" && uri.fsPath.startsWith(Uri.file(root).fsPath) ? workspace.workspaceFolders : undefined,
		);
		stub.on("workspace.asRelativePath", (uri: Uri) => {
			const relative = path.relative(Uri.file(root).fsPath, uri.fsPath);
			return relative.startsWith("..") ? uri.fsPath : relative.split(path.sep).join("/");
		});
	});

	it("lists other open editors inside the workspace but not files outside it", () => {
		window.tabGroups.all = [
			{
				tabs: [
					{ input: new TabInputText(inside("src/a.ts")) },
					{ input: new TabInputText(Uri.file(path.resolve("/home/me/.ssh/config"))) },
					{ input: new TabInputText(Uri.parse("untitled:Untitled-1")) },
					{ input: new TabInputText(inside("src/b.ts")) },
				],
			},
		];
		const block = editorContextBlock(memoryLogger());
		assert.match(block, /^open editors: src\/a\.ts, src\/b\.ts$/m);
		assert.ok(!block.includes(".ssh"), block);
		assert.ok(!block.includes("Untitled-1"), block);
	});

	it("describes the active editor inside the workspace with its selection and diagnostics", () => {
		const active = inside("src/a.ts");
		window.activeTextEditor = editor(active, "const secret = 1;", 6, 12);
		stub.on("languages.getDiagnostics", () => [
			[active, [{ severity: DiagnosticSeverity.Error, range: new Range(new Position(0, 0), new Position(0, 1)), message: "bad", source: "ts" }]],
			[inside("src/b.ts"), [{ severity: DiagnosticSeverity.Warning, range: new Range(new Position(4, 0), new Position(4, 1)), message: "meh" }]],
		]);
		const block = editorContextBlock(memoryLogger());
		assert.match(block, /^active file: src\/a\.ts \(typescript\), cursor 1:13$/m);
		assert.match(block, /^selection \(lines 1-1\):\n```typescript\nsecret\n```$/m);
		assert.match(block, /^- error L1: bad \[ts\]$/m);
		assert.ok(!block.includes("meh"), block);
		assert.match(block, /^workspace diagnostics: 1 errors, 1 warnings$/m);
	});

	for (const [where, uri] of [
		["outside the workspace", Uri.file(path.resolve("/home/me/.env"))],
		["in the user settings", Uri.parse("vscode-userdata:/c%3A/Users/me/settings.json")],
		["in an untitled buffer", Uri.parse("untitled:Untitled-1")],
	] as const) {
		it(`leaves out the active editor and its selection and diagnostics when it is ${where}`, () => {
			window.activeTextEditor = editor(uri, "TOKEN=abc", 0, 9);
			stub.on("languages.getDiagnostics", () => [
				[uri, [{ severity: DiagnosticSeverity.Error, range: new Range(new Position(0, 0), new Position(0, 1)), message: "leak" }]],
			]);
			const block = editorContextBlock(memoryLogger());
			assert.ok(!block.includes("active file"), block);
			assert.ok(!block.includes("TOKEN"), block);
			assert.ok(!block.includes("leak"), block);
			assert.match(block, /^workspace diagnostics: 1 errors, 0 warnings$/m);
		});
	}
});
