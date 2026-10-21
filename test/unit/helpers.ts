import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "../../src/omp/api";
import { Emitter } from "../../src/omp/emitter";
import type { OmpTransport, TransportClose } from "../../src/omp/client";
import { writeNodeLauncher } from "../fixtures/launcher";

export interface LogRecord {
	level: "error" | "warn" | "info" | "debug" | "trace";
	message: string;
}

export type MemoryLogger = Logger & { traceEnabled: boolean; records: LogRecord[]; text(level?: LogRecord["level"]): string };

/** Records every message; an `error` argument is appended as `: <String(error)>`. */
export function memoryLogger(options: { trace?: boolean } = {}): MemoryLogger {
	const records: LogRecord[] = [];
	const log = (level: LogRecord["level"]) => (message: string, error?: unknown) =>
		records.push({ level, message: error === undefined ? message : `${message}: ${String(error)}` });
	return {
		records,
		traceEnabled: options.trace === true,
		text: level =>
			records
				.filter(r => !level || r.level === level)
				.map(r => r.message)
				.join("\n"),
		error: log("error"),
		warn: log("warn"),
		info: log("info"),
		debug: log("debug"),
		trace: (direction, frame) => records.push({ level: "trace", message: `${direction} ${frame}` }),
	};
}

/** In-memory transport: frames written by the client are parsed and handed to `respond`. */
export class MemoryTransport implements OmpTransport {
	readonly written: Array<Record<string, unknown>> = [];
	readonly #data = new Emitter<Uint8Array>();
	readonly #close = new Emitter<TransportClose>();
	readonly onData = this.#data.event;
	readonly onClose = this.#close.event;
	closed = false;
	failWrites = false;
	/** Accept writes, then report this error through the write's `onError` callback. */
	failWritesLater: Error | undefined;

	constructor(private readonly respond?: (frame: Record<string, unknown>, transport: MemoryTransport) => void) {}

	write(line: string, onError?: (error: Error) => void): void {
		if (this.failWrites || this.closed) throw new Error("write EPIPE");
		const frame = JSON.parse(line) as Record<string, unknown>;
		this.written.push(frame);
		const failure = this.failWritesLater;
		if (failure) {
			queueMicrotask(() => onError?.(failure));
			return;
		}
		this.respond?.(frame, this);
	}

	emit(frame: object | string): void {
		const text = typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`;
		this.#data.fire(Buffer.from(text));
	}

	reply(request: Record<string, unknown>, data?: unknown): void {
		this.emit({ type: "response", id: request.id, command: request.type, success: true, data });
	}

	close(code: number | null = 0, signal: NodeJS.Signals | null = null, details: Pick<TransportClose, "pid" | "stderr"> = {}): void {
		this.closed = true;
		this.#close.fire({ code, signal, ...details });
	}

	sent(type: string): Array<Record<string, unknown>> {
		return this.written.filter(f => f.type === type);
	}
}

export const READY_V2 = {
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
};

export function tick(ms = 0): Promise<void> {
	return sleep(ms);
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await tick(10);
	}
}

/** The repository root: the nearest ancestor of the compiled test holding `package.json` (the test build's `--outdir` varies). */
function repositoryRoot(): string {
	for (let dir = __dirname; ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		if (path.dirname(dir) === dir) throw new Error(`No package.json above ${__dirname}`);
	}
}

/** Temp dirs to remove on exit, shared by every test bundle in the process (each bundle inlines this module). */
const TEMP_DIRS_KEY = Symbol.for("omp.test.tempDirs");

export const FAKE_OMP_SCRIPT = path.join(repositoryRoot(), "test", "fixtures", "fake-omp.mjs");

/** Spawnable fake OMP: the script itself on POSIX; Windows cannot spawn a script, so a temporary `.cmd` shim. */
export const FAKE_OMP = process.platform === "win32" ? temporaryLauncher(FAKE_OMP_SCRIPT) : FAKE_OMP_SCRIPT;

function removeOnExit(dir: string): void {
	const registry = globalThis as { [TEMP_DIRS_KEY]?: string[] };
	if (!registry[TEMP_DIRS_KEY]) {
		const dirs: string[] = [];
		registry[TEMP_DIRS_KEY] = dirs;
		process.on("exit", () => {
			for (const entry of dirs) fs.rmSync(entry, { recursive: true, force: true });
		});
	}
	registry[TEMP_DIRS_KEY].push(dir);
}

function temporaryLauncher(script: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-omp-bin-"));
	removeOnExit(dir);
	return writeNodeLauncher(dir, "fake-omp", script);
}

/** True while `pid` exists and is not a zombie. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		const end = stat.lastIndexOf(")");
		return stat.slice(end + 2, end + 3) !== "Z";
	} catch {
		return true;
	}
}
