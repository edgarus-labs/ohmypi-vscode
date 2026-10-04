import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "../../src/omp/api";
import { Emitter } from "../../src/omp/emitter";
import type { OmpTransport, TransportClose } from "../../src/omp/client";

export interface LogRecord {
	level: "error" | "warn" | "info" | "debug" | "trace";
	message: string;
}

export function memoryLogger(): Logger & { records: LogRecord[]; text(level?: LogRecord["level"]): string } {
	const records: LogRecord[] = [];
	return {
		records,
		text: level =>
			records
				.filter(r => !level || r.level === level)
				.map(r => r.message)
				.join("\n"),
		error: (message, error) => records.push({ level: "error", message: error ? `${message}: ${String(error)}` : message }),
		warn: message => records.push({ level: "warn", message }),
		info: message => records.push({ level: "info", message }),
		debug: message => records.push({ level: "debug", message }),
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

	constructor(private readonly respond?: (frame: Record<string, unknown>, transport: MemoryTransport) => void) {}

	write(line: string): void {
		if (this.failWrites || this.closed) throw new Error("write EPIPE");
		const frame = JSON.parse(line) as Record<string, unknown>;
		this.written.push(frame);
		this.respond?.(frame, this);
	}

	emit(frame: object | string): void {
		const text = typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`;
		this.#data.fire(Buffer.from(text));
	}

	reply(request: Record<string, unknown>, data?: unknown): void {
		this.emit({ type: "response", id: request.id, command: request.type, success: true, data });
	}

	close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		this.closed = true;
		this.#close.fire({ code, signal });
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

/** Compiled tests live in `out/test/unit`; the fixture stays in the source tree. */
export const FAKE_OMP = path.resolve(__dirname, "../../../test/fixtures/fake-omp.mjs");

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
