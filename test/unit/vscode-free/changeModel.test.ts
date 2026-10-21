import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolExecutionEvent } from "../../../src/omp/api";
import { ChangeModel, MAX_SNAPSHOT_BYTES, readSnapshot, type Snapshot } from "../../../src/vscode/changeModel";
import { memoryLogger } from "../helpers";

const cwd = path.resolve("/work/repo");
const file = (name: string) => path.join(cwd, name);
const scope = { cwd, roots: [cwd] };

/** In-memory disk: absent keys are missing files; `reads` lists every path read. */
function disk(initial: Record<string, Snapshot> = {}) {
	const files = new Map<string, Snapshot>(Object.entries(initial));
	const reads: string[] = [];
	return {
		files,
		reads,
		read: async (filePath: string): Promise<Snapshot> => {
			reads.push(filePath);
			return files.has(filePath) ? files.get(filePath) : null;
		},
	};
}

const start = (toolCallId: string, name: string, args: unknown): ToolExecutionEvent => ({ phase: "start", toolCallId, name, args });
const end = (toolCallId: string, name: string, args: unknown, details?: unknown): ToolExecutionEvent => ({
	phase: "end",
	toolCallId,
	name,
	args,
	result: { text: "", isError: false, details },
});

describe("ChangeModel", () => {
	it("tracks a file created by a tool as added", async () => {
		const fake = disk();
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "write", { path: "new.ts" }), scope);
		fake.files.set(file("new.ts"), "a\nb\n");
		const result = await model.apply(end("t1", "write", { path: "new.ts" }), scope);
		assert.equal(result.changesChanged, true);
		assert.deepEqual(model.changes, [{ path: file("new.ts"), status: "A", added: 2, removed: 0 }]);
		assert.equal(model.baseline(file("new.ts")), null);
	});

	it("tracks an edited file as modified against its first-seen content", async () => {
		const fake = disk({ [file("a.ts")]: "one\ntwo\n" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "edit", { path: "a.ts" }), scope);
		fake.files.set(file("a.ts"), "one\nTWO\n");
		await model.apply(end("t1", "edit", { path: "a.ts" }), scope);
		await model.apply(start("t2", "edit", { path: "a.ts" }), scope);
		fake.files.set(file("a.ts"), "one\nTWO\nthree\n");
		await model.apply(end("t2", "edit", { path: "a.ts" }), scope);
		assert.deepEqual(model.changes, [{ path: file("a.ts"), status: "M", added: 2, removed: 1 }]);
		assert.equal(model.baseline(file("a.ts")), "one\ntwo\n");
	});

	it("tracks a removed file as deleted", async () => {
		const fake = disk({ [file("gone.ts")]: "x\n" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "delete", { path: "gone.ts" }), scope);
		fake.files.delete(file("gone.ts"));
		await model.apply(end("t1", "delete", { path: "gone.ts" }), scope);
		assert.deepEqual(model.changes, [{ path: file("gone.ts"), status: "D", added: 0, removed: 1 }]);
	});

	it("drops the row when the file is back at its baseline", async () => {
		const fake = disk({ [file("a.ts")]: "same\n" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "edit", { path: "a.ts" }), scope);
		fake.files.set(file("a.ts"), "changed\n");
		await model.apply(end("t1", "edit", { path: "a.ts" }), scope);
		await model.apply(start("t2", "edit", { path: "a.ts" }), scope);
		fake.files.set(file("a.ts"), "same\n");
		const result = await model.apply(end("t2", "edit", { path: "a.ts" }), scope);
		assert.equal(result.changesChanged, true);
		assert.deepEqual(model.changes, []);
	});

	it("ignores read-only tools", async () => {
		const fake = disk({ [file("a.ts")]: "x" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "read", { path: "a.ts" }), scope);
		await model.apply(end("t1", "read", { path: "a.ts" }), scope);
		assert.deepEqual(fake.reads, []);
		assert.deepEqual(model.changes, []);
	});

	it("replaces a snapshot taken after the write with the same call's reported oldText", async () => {
		const fake = disk({ [file("a.ts")]: "after\n" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "edit", { path: "a.ts" }), scope);
		const result = await model.apply(end("t1", "edit", { path: "a.ts" }, { path: file("a.ts"), oldText: "before\n" }), scope);
		assert.deepEqual(result.baselinesChanged, [file("a.ts")]);
		assert.equal(model.baseline(file("a.ts")), "before\n");
		assert.deepEqual(model.changes, [{ path: file("a.ts"), status: "M", added: 1, removed: 1 }]);
	});

	it("keeps an earlier call's baseline over a later call's oldText", async () => {
		const fake = disk({ [file("a.ts")]: "v1\n" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "edit", { path: "a.ts" }), scope);
		fake.files.set(file("a.ts"), "v2\n");
		await model.apply(end("t1", "edit", { path: "a.ts" }), scope);
		await model.apply(start("t2", "edit", { path: "a.ts" }), scope);
		fake.files.set(file("a.ts"), "v3\n");
		await model.apply(end("t2", "edit", { path: "a.ts" }, { path: file("a.ts"), oldText: "v2\n" }), scope);
		assert.equal(model.baseline(file("a.ts")), "v1\n");
	});

	it("skips files that cannot be snapshotted", async () => {
		const fake = disk({ [file("big.bin")]: undefined });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "write", { path: "big.bin" }), scope);
		await model.apply(end("t1", "write", { path: "big.bin" }), scope);
		assert.equal(model.hasBaseline(file("big.bin")), false);
		assert.deepEqual(model.changes, []);
	});

	it("forgets every change and baseline on clear", async () => {
		const fake = disk({ [file("a.ts")]: "x" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "edit", { path: "a.ts" }), scope);
		fake.files.set(file("a.ts"), "y");
		await model.apply(end("t1", "edit", { path: "a.ts" }), scope);
		model.clear();
		assert.deepEqual(model.changes, []);
		assert.equal(model.hasBaseline(file("a.ts")), false);
	});

	it("does not read or track paths outside the workspace roots", async () => {
		const outside = path.resolve("/elsewhere/secret.txt");
		const unc = "\\\\attacker\\share\\x.txt";
		const fake = disk({ [outside]: "s", [file("in.ts")]: "i" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "write", { paths: [outside, unc, "../escape.ts", "~/.ssh/config", "in.ts"] }), scope);
		await model.apply(end("t1", "write", { paths: [outside, unc] }, { path: outside, oldText: "old" }), scope);
		assert.deepEqual(fake.reads, [file("in.ts")]);
		assert.deepEqual(model.changes, []);
		assert.equal(model.hasBaseline(outside), false);
	});

	it("tracks paths inside any workspace root", async () => {
		const other = path.resolve("/work/other");
		const fake = disk({ [path.join(other, "b.ts")]: "b" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "edit", { path: path.join(other, "b.ts") }), { cwd, roots: [cwd, other] });
		assert.equal(model.hasBaseline(path.join(other, "b.ts")), true);
	});

	it("does not track a reported path whose baseline is unknown", async () => {
		const fake = disk({ [file("real.ts")]: "existing\n" });
		const logger = memoryLogger();
		const model = new ChangeModel(fake.read, logger);
		await model.apply(start("t1", "edit", { path: "link.ts" }), scope);
		const result = await model.apply(end("t1", "edit", { path: "link.ts" }, { resolvedPath: file("real.ts") }), scope);
		assert.equal(result.changesChanged, false);
		assert.deepEqual(model.changes, []);
		assert.equal(model.hasBaseline(file("real.ts")), false);
	});

	it("uses a reported oldText as the baseline of a path not snapshotted at start", async () => {
		const fake = disk({ [file("real.ts")]: "new\n" });
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(end("t1", "edit", {}, { path: file("real.ts"), oldText: "old\n" }), scope);
		assert.deepEqual(model.changes, [{ path: file("real.ts"), status: "M", added: 1, removed: 1 }]);
	});

	it("keeps a file the tool created as added when the tool reports an empty oldText", async () => {
		const fake = disk();
		const model = new ChangeModel(fake.read, memoryLogger());
		await model.apply(start("t1", "write", { path: "new.ts" }), scope);
		fake.files.set(file("new.ts"), "x\n");
		await model.apply(end("t1", "write", { path: "new.ts" }, { path: file("new.ts"), oldText: "" }), scope);
		assert.deepEqual(model.changes, [{ path: file("new.ts"), status: "A", added: 1, removed: 0 }]);
		assert.equal(model.baseline(file("new.ts")), null);
	});

	it("drops the work of an event that was in flight when cleared", async () => {
		let release!: () => void;
		const blocked = new Promise<void>(resolve => (release = resolve));
		const model = new ChangeModel(async () => {
			await blocked;
			return "x";
		}, memoryLogger());
		const applying = model.apply(start("t1", "edit", { path: "a.ts" }), scope);
		model.clear();
		release();
		await applying;
		assert.equal(model.hasBaseline(file("a.ts")), false);
	});

	it("treats a Windows path as one file whatever its drive letter case and form", async function () {
		if (process.platform !== "win32") this.skip();
		const upper = `${cwd[0].toUpperCase()}${cwd.slice(1)}`;
		const lower = `${cwd[0].toLowerCase()}${cwd.slice(1)}`;
		const fake = disk({ [path.join(upper, "a.ts")]: "one\n", [path.join(lower, "a.ts")]: "one\n" });
		const model = new ChangeModel(fake.read, memoryLogger());
		const lowerScope = { cwd: lower, roots: [lower] };
		await model.apply(start("t1", "edit", { path: path.join(upper, "a.ts").replace(/\\/g, "/") }), lowerScope);
		fake.files.set(path.join(upper, "a.ts"), "two\n");
		fake.files.set(path.join(lower, "a.ts"), "two\n");
		await model.apply(end("t1", "edit", { path: path.join(upper, "a.ts").replace(/\\/g, "/") }), lowerScope);
		await model.apply(start("t2", "edit", { path: "a.ts" }), lowerScope);
		await model.apply(end("t2", "edit", { path: "a.ts" }), lowerScope);
		assert.equal(model.changes.length, 1);
		assert.equal(model.change(path.join(lower, "a.ts"))?.status, "M");
		assert.equal(model.baseline(path.join(lower, "a.ts")), "one\n");
		assert.equal(model.baseline(path.join(upper, "a.ts")), "one\n");
	});

	describe("baseline memory limit", () => {
		const settle = async (model: ChangeModel, id: string, name: string) => {
			await model.apply(start(id, "edit", { path: name }), scope);
			await model.apply(end(id, "edit", { path: name }), scope);
		};

		it("evicts settled baselines of unchanged files to make room", async () => {
			const fake = disk({ [file("a.ts")]: "aaaaaa", [file("b.ts")]: "bbbbbb" });
			const model = new ChangeModel(fake.read, memoryLogger(), 10);
			await settle(model, "t1", "a.ts");
			await model.apply(start("t2", "edit", { path: "b.ts" }), scope);
			assert.equal(model.hasBaseline(file("a.ts")), false);
			assert.equal(model.baseline(file("b.ts")), "bbbbbb");
		});

		it("keeps baselines of changed files and stops tracking new ones, with a warning", async () => {
			const fake = disk({ [file("a.ts")]: "aaaaaa", [file("b.ts")]: "bbbbbb" });
			const logger = memoryLogger();
			const model = new ChangeModel(fake.read, logger, 10);
			await model.apply(start("t1", "edit", { path: "a.ts" }), scope);
			fake.files.set(file("a.ts"), "changed");
			await model.apply(end("t1", "edit", { path: "a.ts" }), scope);
			await settle(model, "t2", "b.ts");
			assert.equal(model.baseline(file("a.ts")), "aaaaaa");
			assert.equal(model.hasBaseline(file("b.ts")), false);
			assert.deepEqual(
				model.changes.map(change => change.path),
				[file("a.ts")],
			);
			assert.match(logger.text("warn"), /b\.ts.*limit/);
		});

		it("keeps the baseline of a file whose tool call is still running", async () => {
			const fake = disk({ [file("a.ts")]: "aaaaaa", [file("b.ts")]: "bbbbbb" });
			const model = new ChangeModel(fake.read, memoryLogger(), 10);
			await model.apply(start("t1", "edit", { path: "a.ts" }), scope);
			await model.apply(start("t2", "edit", { path: "b.ts" }), scope);
			assert.equal(model.baseline(file("a.ts")), "aaaaaa");
			assert.equal(model.hasBaseline(file("b.ts")), false);
		});
	});
});

describe("readSnapshot", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-snapshot-"));
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it("reads a file, reports a missing one as null", async () => {
		const logger = memoryLogger();
		fs.writeFileSync(path.join(dir, "a.txt"), "hello");
		assert.equal(await readSnapshot(path.join(dir, "a.txt"), logger), "hello");
		assert.equal(await readSnapshot(path.join(dir, "missing.txt"), logger), null);
		assert.deepEqual(logger.records, []);
	});

	it("does not snapshot files over the size limit and logs why", async () => {
		const big = path.join(dir, "big.txt");
		fs.writeFileSync(big, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 0x61));
		const logger = memoryLogger();
		assert.equal(await readSnapshot(big, logger), undefined);
		assert.match(logger.text("debug"), /big\.txt.*exceeds/);
	});

	it("does not snapshot directories and logs why", async () => {
		const logger = memoryLogger();
		assert.equal(await readSnapshot(dir, logger), undefined);
		assert.match(logger.text("debug"), /not a regular file/);
	});
});
