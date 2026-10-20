import * as assert from "node:assert/strict";
import { pickContextFiles } from "../../src/ui/contextPicker";
import { type MemoryLogger, memoryLogger, tick } from "./helpers";
import { EventEmitter, stub, window, workspace } from "./stubs/vscode";

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
});
