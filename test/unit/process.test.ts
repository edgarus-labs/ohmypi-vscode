import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TransportClose } from "../../src/omp/client";
import { killProcessTree, OmpProcess } from "../../src/omp/process";
import { writeNodeLauncher } from "../fixtures/launcher";
import { FAKE_OMP, FAKE_OMP_SCRIPT, isAlive, memoryLogger, tick, waitFor } from "./helpers";
describe("OmpProcess (fake-omp child process)", function () {
	this.timeout(15000);
	let sessionDir: string;
	const started: OmpProcess[] = [];
	/** Processes a test let escape the OMP process tree on purpose. */
	const strays: number[] = [];

	beforeEach(() => {
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-proc-"));
	});
	afterEach(async () => {
		for (const pid of strays.splice(0)) {
			try {
				process.kill(pid);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
			}
			await waitFor(() => !isAlive(pid), 3000, `stray ${pid} gone`);
		}
		const shutdowns = await Promise.allSettled(started.splice(0).map(proc => proc.shutdown(500)));
		fs.rmSync(sessionDir, { recursive: true, force: true });
		const failed = shutdowns.find(result => result.status === "rejected");
		if (failed) throw failed.reason;
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
		const args = ["--profile", "a b", "--name", 'x&y|z "q" 100% ^c', "%OS%", "!OS!", "trailing\\", ""];
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

	it("decodes a multibyte character split between stderr chunks", async () => {
		const { closes } = spawnScript(
			'const b = Buffer.from("żółw\\n"); process.stderr.write(b.subarray(0, 1)); setTimeout(() => { process.stderr.write(b.subarray(1)); process.exitCode = 1; }, 200);',
		);
		await waitFor(() => closes.length > 0, 5000, "exit");
		assert.equal(closes[0].stderr, "żółw");
	});

	it("logs an unterminated stderr line in bounded pieces", async () => {
		const { logger, closes } = spawnScript('process.stderr.write("a".repeat(200 * 1024)); process.stderr.write("b".repeat(10)); process.exitCode = 1;');
		await waitFor(() => closes.length > 0, 5000, "exit");
		const pieces = logger.records.filter(r => r.level === "debug" && r.message.startsWith("omp: ")).map(r => r.message.length - "omp: ".length);
		assert.ok(pieces.length >= 3 && pieces.every(length => length <= 64 * 1024), JSON.stringify(pieces));
		assert.equal(pieces.reduce((sum, length) => sum + length, 0), 200 * 1024 + 10);
		assert.ok(closes[0].stderr?.endsWith("a".repeat(100) + "b".repeat(10)));
	});

	it("delivers no output after reporting the close when an escaped descendant still holds stdout", async () => {
		const { proc, logger, closes } = spawnScript(`
			const { spawn } = require("node:child_process");
			const child = spawn(process.execPath, ["-e", "setInterval(() => process.stdout.write('late\\\\n'), 50); setTimeout(() => process.exit(), 10000);"], { stdio: ["ignore", "inherit", "ignore"], detached: true });
			process.stderr.write("escaped pid " + child.pid + "\\n");
			child.unref();
			setTimeout(() => process.exit(0), 200);
		`);
		const late: string[] = [];
		proc.onData(chunk => {
			if (closes.length > 0) late.push(Buffer.from(chunk).toString("utf8"));
		});
		await waitFor(() => /escaped pid (\d+)/.test(logger.text("debug")), 5000, "escaped pid");
		strays.push(Number(/escaped pid (\d+)/.exec(logger.text("debug"))![1]));
		await waitFor(() => closes.length > 0, 5000, "close");
		// The escaped process writes every 50 ms on real time; silence over several of its periods shows the stream is detached.
		await tick(300);
		assert.deepEqual(late, []);
	});

	it("reports a write the pipe rejects after the process went away", async () => {
		const { proc } = spawnScript("");
		const errors: Error[] = [];
		// Larger than any pipe buffer, so the write is still pending when the process exits without reading.
		proc.write(`${JSON.stringify({ type: "prompt", message: "x".repeat(4 * 1024 * 1024) })}\n`, error => errors.push(error));
		await waitFor(() => errors.length > 0, 5000, "write error");
		assert.ok(errors[0] instanceof Error);
	});

	it("shuts down gracefully via stdin EOF, idempotently, leaving no process of the tree behind", async () => {
		const { proc, logger, closes, stdout } = spawnFake({ FAKE_OMP_SPAWN_CHILD: "1" });
		await waitFor(() => stdout().includes("ready"));
		await waitFor(() => /child pid (\d+)/.test(logger.text("debug")), 5000, "grandchild pid");
		const grandchild = Number(/child pid (\d+)/.exec(logger.text("debug"))![1]);
		const pid = proc.pid!;
		const first = proc.shutdown(3000);
		const second = proc.shutdown(3000);
		await Promise.all([first, second]);
		assert.equal(closes.length, 1);
		assert.equal(closes[0].code, 0);
		assert.equal(isAlive(pid), false);
		await waitFor(() => !isAlive(grandchild), 3000, "grandchild gone");
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
