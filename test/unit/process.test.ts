import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TransportClose } from "../../src/omp/client";
import { killProcessTree, OmpProcess } from "../../src/omp/process";
import { writeNodeLauncher } from "../fixtures/launcher";
import { FAKE_OMP, FAKE_OMP_SCRIPT, isAlive, memoryLogger, waitFor } from "./helpers";
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

	/** An OMP stand-in running `source` with the current Node, launched like an installed launcher. */
	function spawnScript(source: string) {
		const script = path.join(sessionDir, "script.js");
		fs.writeFileSync(script, source);
		const launcher = writeNodeLauncher(sessionDir, "script-omp", script);
		const logger = memoryLogger();
		const proc = new OmpProcess({ executable: launcher, args: [], cwd: sessionDir, logger });
		started.push(proc);
		const closes: TransportClose[] = [];
		proc.onClose(close => closes.push(close));
		return { proc, logger, closes };
	}

	it("spawns with --mode rpc-ui plus extra args and forwards stdout and stderr", async () => {
		const { proc, logger, stdout } = spawnFake();
		assert.ok(proc.pid);
		await waitFor(() => stdout().includes('"type":"ready"'), 5000, "ready");
		await waitFor(() => logger.text("debug").includes("fake-omp started"), 5000, "stderr");
		assert.match(logger.text("debug"), /args \["--mode","rpc-ui","--profile","x"\]/);
	});

	it("launches an installed launcher whose path and arguments contain spaces and shell metacharacters", async () => {
		const binDir = path.join(sessionDir, "my tools (x86) & more");
		fs.mkdirSync(binDir);
		const launcher = writeNodeLauncher(binDir, "omp", FAKE_OMP_SCRIPT);
		const args = ["--profile", "a b", "--name", 'x&y|z "q" 100% ^c'];
		const logger = memoryLogger();
		const proc = new OmpProcess({ executable: launcher, args, cwd: sessionDir, env: { ...process.env, FAKE_OMP_SESSION_DIR: sessionDir }, logger });
		started.push(proc);
		const closes: TransportClose[] = [];
		proc.onClose(close => closes.push(close));
		await waitFor(() => logger.text("debug").includes("fake-omp started") || closes.length > 0, 5000, "start");
		assert.match(logger.text("debug"), /fake-omp started/, logger.text());
		const logged = /args (\[.*\])/.exec(logger.text("debug"))![1];
		assert.deepEqual(JSON.parse(logged), ["--mode", "rpc-ui", ...args]);
	});

	it("reports the exit code, process id and stderr tail when the process dies", async () => {
		const { proc, closes, stdout } = spawnFake();
		await waitFor(() => stdout().includes("ready"));
		proc.write(`${JSON.stringify({ id: "p", type: "prompt", message: "please crash" })}\n`);
		await waitFor(() => closes.length > 0, 5000, "exit");
		assert.equal(closes[0].code, 3);
		assert.equal(closes[0].pid, proc.pid);
		assert.match(closes[0].stderr ?? "", /fake-omp started/);
		assert.equal(proc.exited, true);
		assert.throws(() => proc.write("{}\n"), /not running/);
	});

	it("keeps only the last 20 stderr lines, including an unterminated one", async () => {
		const { closes } = spawnScript(
			'for (let i = 1; i <= 50; i++) process.stderr.write(`line ${i}\\n`); process.stderr.write("last words"); process.exitCode = 1;',
		);
		await waitFor(() => closes.length > 0, 5000, "exit");
		const expected = [...Array.from({ length: 19 }, (_, i) => `line ${i + 32}`), "last words"].join("\n");
		assert.equal(closes[0].stderr, expected);
	});

	it("bounds the stderr tail to its last 4000 characters", async () => {
		const { closes } = spawnScript('process.stderr.write("a".repeat(3000) + "\\n" + "b".repeat(3000) + "\\n"); process.exitCode = 1;');
		await waitFor(() => closes.length > 0, 5000, "exit");
		const tail = closes[0].stderr ?? "";
		assert.equal(tail.length, 4000);
		assert.ok(tail.startsWith("…"));
		assert.ok(tail.endsWith(`a\n${"b".repeat(3000)}`));
	});

	it("reports a write the pipe rejects after the process went away", async () => {
		const { proc } = spawnScript("");
		const errors: Error[] = [];
		// Larger than any pipe buffer, so the write is still pending when the process exits without reading.
		proc.write(`${JSON.stringify({ type: "prompt", message: "x".repeat(4 * 1024 * 1024) })}\n`, error => errors.push(error));
		await waitFor(() => errors.length > 0, 5000, "write error");
		assert.ok(errors[0] instanceof Error);
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

	it("escalates past an ignored stdin EOF and SIGTERM and kills the whole process tree", async () => {
		const { proc, logger, stdout } = spawnFake({ FAKE_OMP_IGNORE_EOF: "1", FAKE_OMP_IGNORE_SIGTERM: "1", FAKE_OMP_SPAWN_CHILD: "1" });
		await waitFor(() => stdout().includes("ready"));
		await waitFor(() => /child pid (\d+)/.test(logger.text("debug")), 5000, "grandchild pid");
		const grandchild = Number(/child pid (\d+)/.exec(logger.text("debug"))![1]);
		const pid = proc.pid!;
		assert.ok(isAlive(grandchild));
		const startedAt = Date.now();
		await proc.shutdown(300);
		const elapsed = Date.now() - startedAt;
		await waitFor(() => !isAlive(pid) && !isAlive(grandchild), 3000, "process tree gone");
		if (process.platform === "win32") {
			// taskkill /T /F has no graceful stage: the tree dies when the EOF grace period ends.
			assert.ok(elapsed >= 300, "waited through the EOF grace period");
			assert.match(logger.text("info"), /taskkill/);
			assert.doesNotMatch(`${logger.text("info")}\n${logger.text("warn")}`, /SIGTERM|SIGKILL/);
		} else {
			assert.ok(elapsed >= 600, "waited through EOF and SIGTERM grace periods");
			assert.match(logger.text("debug"), /ignoring SIGTERM/);
		}
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

	it("logs a taskkill that fails to kill the process tree", async function () {
		if (process.platform !== "win32") this.skip();
		const gone = spawnScript("");
		await waitFor(() => gone.closes.length > 0, 5000, "exit");
		const pid = gone.proc.pid!;
		const logger = memoryLogger();
		await killProcessTree(pid, "SIGKILL", logger);
		assert.match(logger.text("warn"), new RegExp(`taskkill /pid ${pid} /T /F exited with code 128`));
	});
});
