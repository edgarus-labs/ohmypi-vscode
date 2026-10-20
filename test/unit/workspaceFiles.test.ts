import * as assert from "node:assert/strict";
import * as path from "node:path";
import { openToolFile, workspaceRoots } from "../../src/vscode/workspaceFiles";
import { FileSystemError, Range, stub, Uri, workspace } from "./stubs/vscode";

describe("workspace files", () => {
	const cwd = path.resolve("/work/repo");
	const folder = path.resolve("/work/docs");

	beforeEach(() => {
		stub.reset();
		workspace.workspaceFolders = [{ uri: Uri.file(folder) }];
	});

	it("treats the working directory and every workspace folder as roots", () => {
		assert.deepEqual(workspaceRoots(cwd), [cwd, Uri.file(folder).fsPath]);
	});

	it("opens a file inside the workspace at the given line without asking", async () => {
		await openToolFile("src/a.ts", 12, cwd);
		assert.deepEqual(stub.callsTo("window.showWarningMessage"), []);
		const [[uri, options]] = stub.callsTo("window.showTextDocument") as [[Uri, { preview: boolean; selection: Range }]];
		assert.equal(uri.fsPath, Uri.file(path.join(cwd, "src", "a.ts")).fsPath);
		assert.equal(options.preview, true);
		assert.equal(options.selection.start.line, 11);
	});

	it("opens a file in another workspace folder without asking", async () => {
		await openToolFile(path.join(folder, "guide.md"), undefined, cwd);
		assert.deepEqual(stub.callsTo("window.showWarningMessage"), []);
		assert.equal(stub.callsTo("window.showTextDocument").length, 1);
	});

	it("asks before touching a file outside the workspace and respects a refusal", async () => {
		const outside = path.resolve("/etc/hosts");
		await openToolFile(outside, undefined, cwd);
		const [[message, options, ...actions]] = stub.callsTo("window.showWarningMessage") as [[string, { modal: boolean }, ...string[]]];
		assert.match(message, /outside the workspace/);
		assert.ok(message.includes(outside));
		assert.equal(options.modal, true);
		assert.deepEqual(actions, ["Open"]);
		assert.deepEqual(stub.callsTo("window.showTextDocument"), []);
		assert.deepEqual(stub.callsTo("workspace.fs.stat"), []);
	});

	it("opens a file outside the workspace once confirmed", async () => {
		stub.on("window.showWarningMessage", () => "Open");
		await openToolFile("\\\\server\\share\\x.txt", undefined, cwd);
		assert.equal(stub.callsTo("window.showTextDocument").length, 1);
	});

	it("rejects URLs", async () => {
		await assert.rejects(openToolFile("https://example.com/a", undefined, cwd), /Not a local file: https:\/\/example\.com\/a/);
		assert.deepEqual(stub.callsTo("window.showTextDocument"), []);
	});

	describe("a file that does not exist", () => {
		const shown = () => (stub.callsTo("window.showTextDocument") as [[Uri]]).map(([uri]) => uri.fsPath);

		beforeEach(() => {
			stub.on("workspace.fs.stat", (uri: Uri) => Promise.reject(FileSystemError.FileNotFound(uri)));
			stub.on("workspace.asRelativePath", (uri: Uri) => path.relative(folder, uri.fsPath).replace(/\\/g, "/"));
		});

		it("opens the only workspace file with that name", async () => {
			const found = Uri.file(path.join(folder, "src", "extension.ts"));
			stub.on("workspace.findFiles", () => [found]);
			await openToolFile("extension.ts", 3, cwd);
			assert.deepEqual(stub.callsTo("workspace.findFiles"), [["**/extension.ts", "**/{node_modules,.git}/**", 20]]);
			assert.deepEqual(shown(), [found.fsPath]);
			const [[, options]] = stub.callsTo("window.showTextDocument") as [[Uri, { selection: Range }]];
			assert.equal(options.selection.start.line, 2);
		});

		it("lets the user pick among several workspace files with that name", async () => {
			const first = Uri.file(path.join(folder, "a", "index.ts"));
			const second = Uri.file(path.join(folder, "b", "index.ts"));
			stub.on("workspace.findFiles", () => [first, second]);
			stub.on("window.showQuickPick", (items: Array<{ label: string }>) => items[1]);
			await openToolFile("index.ts", undefined, cwd);
			const [[items, options]] = stub.callsTo("window.showQuickPick") as [[Array<{ label: string }>, { placeHolder: string }]];
			assert.deepEqual(
				items.map(item => item.label),
				["a/index.ts", "b/index.ts"],
			);
			assert.match(options.placeHolder, /index\.ts/);
			assert.deepEqual(shown(), [second.fsPath]);
		});

		it("opens nothing when the user dismisses the pick", async () => {
			stub.on("workspace.findFiles", () => [Uri.file(path.join(folder, "a", "index.ts")), Uri.file(path.join(folder, "b", "index.ts"))]);
			await openToolFile("index.ts", undefined, cwd);
			assert.deepEqual(shown(), []);
		});

		it("reports a name found nowhere in the workspace", async () => {
			stub.on("workspace.findFiles", () => []);
			await assert.rejects(openToolFile("nowhere.ts:4", undefined, cwd), /^Error: File not found: nowhere\.ts:4$/);
			assert.deepEqual(shown(), []);
		});

		it("reports a missing path with a directory part without searching", async () => {
			await assert.rejects(openToolFile("src/gone.ts", undefined, cwd), /^Error: File not found: src\/gone\.ts$/);
			assert.deepEqual(stub.callsTo("workspace.findFiles"), []);
			assert.deepEqual(shown(), []);
		});

		it("does not search for a name that is a glob pattern", async () => {
			await assert.rejects(openToolFile("*.ts", undefined, cwd), /^Error: File not found: \*\.ts$/);
			assert.deepEqual(stub.callsTo("workspace.findFiles"), []);
		});
	});

	it("surfaces a failure to check whether the file exists", async () => {
		stub.on("workspace.fs.stat", () => Promise.reject(new Error("disk on fire")));
		await assert.rejects(openToolFile("a.ts", undefined, cwd), /disk on fire/);
		assert.deepEqual(stub.callsTo("window.showTextDocument"), []);
	});
});
