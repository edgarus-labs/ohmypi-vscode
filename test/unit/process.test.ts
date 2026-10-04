import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TransportClose } from "../../src/omp/client";
import { OmpProcess } from "../../src/omp/process";
import { FAKE_OMP, isAlive, memoryLogger, waitFor } from "./helpers";
describe("OmpProcess (fake-omp child process)", function () {
	this.timeout(15000);
	let sessionDir: string;
	const started: OmpProcess[] = [];

	beforeEach(() => {
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-proc-"));
	});
	afterEach(async () => {
		for (const proc of started.splice(0)) await proc.shutdown(500);
		fs.rmSync(sessionDir, { recursive: true, force: true });
	});

	function spawnFake(env: Record<string, string> = {}, extraArgs: string[] = ["--profile", "x"]) {
		const logger = memoryLogger();
		const proc = new OmpProcess({
			executable: FAKE_OMP,
			args: extraArgs,
			cwd: sessionDir,
			env: { ...process.env, FAKE_OMP_SESSION_DIR: sessionDir, ...env },
			logger,
		});
		started.push(proc);
		const chunks: Buffer[] = [];
		const closes: TransportClose[] = [];
		proc.onData(chunk => chunks.push(Buffer.from(chunk)));
		proc.onClose(close => closes.push(close));
		return { proc, logger, closes, stdout: () => Buffer.concat(chunks).toString("utf8") };
	}

	it("spawns with --mode rpc-ui plus extra args and forwards stdout and stderr", async () => {
		const { proc, logger, stdout } = spawnFake();
		assert.ok(proc.pid);
		await waitFor(() => stdout().includes('"type":"ready"'), 5000, "ready");
		await waitFor(() => logger.text("debug").includes("fake-omp started"), 5000, "stderr");
		assert.match(logger.text("debug"), /args --mode rpc-ui --profile x/);
	});

	it("reports the exit code when the process dies", async () => {
		const { proc, closes, stdout } = spawnFake();
		await waitFor(() => stdout().includes("ready"));
		proc.write(`${JSON.stringify({ id: "p", type: "prompt", message: "please crash" })}\n`);
		await waitFor(() => closes.length > 0, 5000, "exit");
		assert.equal(closes[0].code, 3);
		assert.equal(proc.exited, true);
		assert.throws(() => proc.write("{}\n"), /not running/);
	});

	it("shuts down gracefully via stdin EOF, idempotently, leaving no process behind", async () => {
		const { proc, closes, stdout } = spawnFake();
		await waitFor(() => stdout().includes("ready"));
		const pid = proc.pid!;
		const first = proc.shutdown(3000);
		const second = proc.shutdown(3000);
		await Promise.all([first, second]);
		assert.equal(closes.length, 1);
		assert.equal(closes[0].code, 0);
		assert.equal(isAlive(pid), false);
	});

	it("escalates to SIGTERM and SIGKILL for the whole process group", async () => {
		const { proc, logger, stdout } = spawnFake({ FAKE_OMP_IGNORE_EOF: "1", FAKE_OMP_IGNORE_SIGTERM: "1", FAKE_OMP_SPAWN_CHILD: "1" });
		await waitFor(() => stdout().includes("ready"));
		await waitFor(() => /child pid (\d+)/.test(logger.text("debug")), 5000, "grandchild pid");
		const grandchild = Number(/child pid (\d+)/.exec(logger.text("debug"))![1]);
		const pid = proc.pid!;
		assert.ok(isAlive(grandchild));
		const startedAt = Date.now();
		await proc.shutdown(300);
		assert.ok(Date.now() - startedAt >= 600, "waited through EOF and SIGTERM grace periods");
		await waitFor(() => !isAlive(pid) && !isAlive(grandchild), 3000, "process tree gone");
		assert.match(logger.text("debug"), /ignoring SIGTERM/);
	});

	it("kills leftover group members when the main process exits on its own", async () => {
		const { proc, logger, closes, stdout } = spawnFake({ FAKE_OMP_SPAWN_CHILD: "1" });
		await waitFor(() => stdout().includes("ready"));
		await waitFor(() => /child pid (\d+)/.test(logger.text("debug")), 5000, "grandchild pid");
		const grandchild = Number(/child pid (\d+)/.exec(logger.text("debug"))![1]);
		proc.write(`${JSON.stringify({ id: "p", type: "prompt", message: "crash now" })}\n`);
		await waitFor(() => closes.length > 0, 5000, "exit");
		await waitFor(() => !isAlive(grandchild), 3000, "grandchild gone");
	});

	it("reports a spawn failure as a close with an error", async () => {
		const logger = memoryLogger();
		const proc = new OmpProcess({ executable: path.join(sessionDir, "missing-omp"), args: [], cwd: sessionDir, logger });
		const closes: TransportClose[] = [];
		proc.onClose(close => closes.push(close));
		await waitFor(() => closes.length > 0, 5000, "spawn failure");
		assert.match(closes[0].error!.message, /ENOENT/);
		assert.throws(() => proc.write("{}\n"), /not running/);
		await proc.shutdown(100);
	});
});
