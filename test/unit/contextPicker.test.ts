import * as assert from "node:assert/strict";
import * as path from "node:path";
import { deferred } from "../../src/shared/deferred";
import { pickContextFiles } from "../../src/ui/contextPicker";
import { type MemoryLogger, memoryLogger, tick } from "./helpers";
import { EventEmitter, stub, Uri, window, workspace } from "./stubs/vscode";

class FakeQuickPick {
	title = "";
	placeholder = "";
	canSelectMany = false;
	matchOnDescription = false;
	busy = false;
	items: unknown[] = [];
	selectedItems: unknown[] = [];
	activeItems: unknown[] = [];
	readonly accepted = new EventEmitter<void>();
	readonly hidden = new EventEmitter<void>();
	readonly onDidAccept = this.accepted.event;
	readonly onDidHide = this.hidden.event;
	show(): void {}
	hide(): void {
		this.hidden.fire();
	}
	dispose(): void {}
}

describe("pickContextFiles", () => {
	const patched = { window: window as Record<string, unknown>, workspace: workspace as Record<string, unknown> };
	let picker: FakeQuickPick;
	let logger: MemoryLogger;

	beforeEach(() => {
		stub.reset();
		picker = new FakeQuickPick();
		logger = memoryLogger();
		patched.window.createQuickPick = () => picker;
	});

	afterEach(() => {
		delete patched.window.createQuickPick;
		delete patched.workspace.findFiles;
	});

	it("reports a failed workspace search in the picker and the log", async () => {
		patched.workspace.findFiles = () => Promise.reject(new Error("search provider crashed"));
		const picked = pickContextFiles(logger);
		await tick();
		assert.equal(picker.busy, false);
		assert.match(picker.title, /workspace search failed: search provider crashed/);
		assert.match(logger.text("warn"), /Workspace file search failed: Error: search provider crashed/);
		picker.hide();
		assert.deepEqual(await picked, []);
	});

	it("leaves out what files.exclude and search.exclude hide, besides node_modules and .git", async () => {
		stub.config.set("files.exclude", { "**/.git": true, "**/*.{js,map}": true, "**/dist": false, "**/*.tmp": { when: "$(basename).ts" } });
		stub.config.set("search.exclude", { "**/out": true, "**/node_modules": true });
		let exclude: unknown;
		patched.workspace.findFiles = (_include: unknown, pattern: unknown) => {
			exclude = pattern;
			return Promise.resolve([]);
		};
		const picked = pickContextFiles(logger);
		await tick();
		assert.equal(typeof exclude, "string");
		const glob = exclude as string;
		assert.ok(glob.startsWith("{") && glob.endsWith("}"), glob);
		assert.deepEqual(
			new Set(glob.slice(1, -1).split(",")),
			new Set(["**/node_modules/**", "**/.git/**", "**/.git", "**/*.js", "**/*.map", "**/out", "**/node_modules"]),
		);
		picker.hide();
		await picked;
	});

	it("cancels the workspace search when the picker closes", async () => {
		let token: { isCancellationRequested: boolean } | undefined;
		const files = deferred<Uri[]>();
		patched.workspace.findFiles = (_include: unknown, _exclude: unknown, _limit: unknown, cancellation: typeof token) => {
			token = cancellation;
			return files.promise;
		};
		const picked = pickContextFiles(logger);
		await tick();
		assert.equal(token?.isCancellationRequested, false);
		picker.hide();
		assert.equal(token?.isCancellationRequested, true);
		assert.deepEqual(await picked, []);
		files.resolve([Uri.file(path.resolve("/work/a.ts"))]);
		await tick();
		assert.deepEqual(picker.items, []);
	});
});
