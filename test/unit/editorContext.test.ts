import * as assert from "node:assert/strict";
import * as path from "node:path";
import { editorContextBlock } from "../../src/vscode/EditorContext";
import { memoryLogger } from "./helpers";
import { stub, TabInputText, Uri, window, workspace } from "./stubs/vscode";

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
});
