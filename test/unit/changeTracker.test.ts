import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OmpServiceApi, SessionView, ToolExecutionEvent, TranscriptItem } from "../../src/omp/api";
import { BASELINE_SCHEME, EMPTY_QUERY } from "../../src/vscode/BaselineContentProvider";
import { ChangeTracker } from "../../src/vscode/ChangeTracker";
import { memoryLogger } from "./helpers";
import { EventEmitter, stub, TabInputTextDiff, Uri, window, workspace } from "./stubs/vscode";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

interface FakeService {
	service: OmpServiceApi;
	tools: EventEmitter<ToolExecutionEvent>;
	sessions: EventEmitter<SessionView>;
}

function fakeService(cwd: string): FakeService {
	const tools = new EventEmitter<ToolExecutionEvent>();
	const sessions = new EventEmitter<SessionView>();
	const service = {
		cwd,
		session: { sessionId: "s1" },
		onToolExecution: tools.event,
		onDidChangeSession: sessions.event,
	} as unknown as OmpServiceApi;
	return { service, tools, sessions };
}

const toolItem = (id: string, args: unknown, details?: unknown): ToolItem => ({
	kind: "tool",
	id,
	name: "edit",
	args,
	status: "done",
	result: { text: "", isError: false, details },
	startedAt: 0,
});

describe("ChangeTracker", () => {
	let dir: string;
	let tracker: ChangeTracker;
	let fake: FakeService;

	beforeEach(() => {
		stub.reset();
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-changes-"));
		tracker = new ChangeTracker(memoryLogger());
		fake = fakeService(dir);
		tracker.setService(fake.service);
	});

	afterEach(() => {
		tracker.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function edit(id: string, name: string, content: string, args: unknown = { path: name }, details?: unknown) {
		fake.tools.fire({ phase: "start", toolCallId: id, name: "edit", args });
		await tracker.whenIdle();
		fs.writeFileSync(path.join(dir, name), content);
		fake.tools.fire({ phase: "end", toolCallId: id, name: "edit", args, result: { text: "", isError: false, details } });
		await tracker.whenIdle();
	}

	function diffCalls() {
		return stub.callsTo("commands.executeCommand").filter(([command]) => command === "vscode.diff") as Array<[string, Uri, Uri, string]>;
	}

	it("lists a changed file with a summary and a diff command", async () => {
		fs.writeFileSync(path.join(dir, "a.ts"), "one\n");
		const summaries: string[] = [];
		tracker.onDidChangeSummary(summary => summaries.push(summary));
		await edit("t1", "a.ts", "two\n");
		assert.deepEqual(tracker.changes, [{ path: path.join(dir, "a.ts"), status: "M", added: 1, removed: 1 }]);
		assert.deepEqual(summaries, ["1 file"]);
		const item = tracker.getTreeItem(tracker.changes[0]);
		assert.equal(item.description, "M · +1 −1");
		assert.equal(item.command?.command, "omp.changes.openDiff");
	});

	it("tracks files in other workspace folders but not outside them", async () => {
		const other = fs.mkdtempSync(path.join(os.tmpdir(), "omp-other-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omp-outside-"));
		try {
			workspace.workspaceFolders = [{ uri: Uri.file(other) }];
			const inOther = path.join(other, "b.ts");
			const notTracked = path.join(outside, "c.ts");
			fake.tools.fire({ phase: "start", toolCallId: "t1", name: "write", args: { paths: [inOther, notTracked] } });
			await tracker.whenIdle();
			fs.writeFileSync(inOther, "b\n");
			fs.writeFileSync(notTracked, "c\n");
			fake.tools.fire({ phase: "end", toolCallId: "t1", name: "write", args: { paths: [inOther, notTracked] } });
			await tracker.whenIdle();
			assert.deepEqual(
				tracker.changes.map(change => change.path),
				[inOther],
			);
		} finally {
			fs.rmSync(other, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("opens the tracked diff of a tool call against the first-seen baseline", async () => {
		fs.writeFileSync(path.join(dir, "a.ts"), "one\n");
		await edit("t1", "a.ts", "two\n");
		assert.equal(await tracker.openToolDiff(toolItem("t1", { path: "a.ts" })), true);
		const [[, left, right, title]] = diffCalls();
		assert.equal(left.scheme, BASELINE_SCHEME);
		assert.equal(left.query, "");
		assert.equal(right.fsPath, Uri.file(path.join(dir, "a.ts")).fsPath);
		assert.equal(title, "a.ts (OMP changes)");
		assert.equal(tracker.contentProvider.provideTextDocumentContent(left as never), "one\n");
	});

	it("shows a deleted file against an empty side", async () => {
		fs.writeFileSync(path.join(dir, "gone.ts"), "x\n");
		fake.tools.fire({ phase: "start", toolCallId: "t1", name: "delete", args: { path: "gone.ts" } });
		await tracker.whenIdle();
		fs.rmSync(path.join(dir, "gone.ts"));
		fake.tools.fire({ phase: "end", toolCallId: "t1", name: "delete", args: { path: "gone.ts" } });
		await tracker.whenIdle();
		await tracker.openDiff(tracker.changes[0]);
		const [[, , right]] = diffCalls();
		assert.equal(right.query, EMPTY_QUERY);
	});

	it("serves an empty baseline for a file the tool created", async () => {
		await edit("t1", "new.ts", "x\n");
		assert.equal(tracker.changes[0].status, "A");
		await tracker.openDiff(tracker.changes[0]);
		const [[, left]] = diffCalls();
		assert.equal(tracker.contentProvider.provideTextDocumentContent(left as never), "");
	});

	it("falls back to the tool's own oldText for an untracked file", async () => {
		fs.writeFileSync(path.join(dir, "b.ts"), "now\n");
		const item = toolItem("t9", {}, { path: path.join(dir, "b.ts"), oldText: "then\n" });
		assert.equal(await tracker.openToolDiff(item), true);
		const [[, left, , title]] = diffCalls();
		assert.equal(title, "b.ts (OMP edit)");
		assert.equal(tracker.contentProvider.provideTextDocumentContent(left as never), "then\n");
		assert.deepEqual(stub.callsTo("window.showWarningMessage"), []);
	});

	it("asks before diffing a file outside the workspace and respects a refusal", async () => {
		const outside = path.resolve("/elsewhere/c.ts");
		const item = toolItem("t9", {}, { path: outside, oldText: "then\n" });
		assert.equal(await tracker.openToolDiff(item), true);
		const [[message, options]] = stub.callsTo("window.showWarningMessage") as [[string, { modal: boolean }]];
		assert.match(message, /outside the workspace/);
		assert.equal(options.modal, true);
		assert.deepEqual(diffCalls(), []);
	});

	it("reports no diff when the tool recorded nothing", async () => {
		assert.equal(await tracker.openToolDiff(toolItem("t9", { path: "x.ts" })), false);
	});

	it("opens the diff of the file asked for when a call changed several", async () => {
		const args = { edits: [{ path: "a.ts" }, { path: "b.ts" }] };
		fake.tools.fire({ phase: "start", toolCallId: "t1", name: "edit", args });
		await tracker.whenIdle();
		fs.writeFileSync(path.join(dir, "a.ts"), "a\n");
		fs.writeFileSync(path.join(dir, "b.ts"), "b\n");
		fake.tools.fire({ phase: "end", toolCallId: "t1", name: "edit", args, result: { text: "", isError: false } });
		await tracker.whenIdle();
		assert.equal(await tracker.openToolDiff(toolItem("t1", args), "b.ts"), true);
		const [[, , right]] = diffCalls();
		assert.equal(right.fsPath, Uri.file(path.join(dir, "b.ts")).fsPath);
	});

	it("refuses a file the tool call does not name", async () => {
		fs.writeFileSync(path.join(dir, "a.ts"), "one\n");
		await edit("t1", "a.ts", "two\n");
		fs.writeFileSync(path.join(dir, "secret.ts"), "x\n");
		await edit("t2", "secret.ts", "y\n");
		assert.equal(await tracker.openToolDiff(toolItem("t1", { path: "a.ts" }), "secret.ts"), false);
		assert.deepEqual(diffCalls(), []);
	});

	it("clears on a session switch and closes its baseline diffs without asking VS Code to reload their deleted baselines", async () => {
		fs.writeFileSync(path.join(dir, "a.ts"), "one\n");
		await edit("t1", "a.ts", "two\n");
		const baselineDiff = { input: new TabInputTextDiff(Uri.file(path.join(dir, "a.ts")).with({ scheme: BASELINE_SCHEME }), Uri.file(path.join(dir, "a.ts"))) };
		const otherTab = { input: new TabInputTextDiff(Uri.file("/x"), Uri.file("/y")) };
		window.tabGroups.all = [{ tabs: [baselineDiff, otherTab] }];
		const changed: string[] = [];
		tracker.onDidChangeBaseline(uri => changed.push(uri.scheme));
		fake.sessions.fire({ sessionId: "s1" } as SessionView);
		assert.equal(tracker.changes.length, 1);
		fake.sessions.fire({ sessionId: "s2" } as SessionView);
		assert.deepEqual(tracker.changes, []);
		assert.deepEqual(stub.callsTo("window.tabGroups.close"), [[[baselineDiff]]]);
		assert.deepEqual(changed, []);
		assert.equal(tracker.summary(), "");
	});
});
