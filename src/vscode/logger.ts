import * as vscode from "vscode";
import type { Logger } from "../omp/api";
import { describeError } from "../shared/errors";

type Level = "error" | "warn" | "info" | "debug";
const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Output-channel logger filtered by `omp.logLevel`; `traceEnabled` follows `omp.traceRpc`. Both settings are read on every use.
 * Logging never throws: VS Code closes the channel while deactivation still stops OMP, and a line written after that is dropped.
 */
export class OutputLogger implements Logger {
	constructor(private readonly channel: vscode.OutputChannel) {}

	get traceEnabled(): boolean {
		return vscode.workspace.getConfiguration("omp").get<boolean>("traceRpc", false);
	}

	private write(level: Level, message: string, error: unknown): void {
		const configured = vscode.workspace.getConfiguration("omp").get<Level>("logLevel", "info");
		if (RANK[level] > (RANK[configured] ?? RANK.info)) return;
		const text = error === undefined ? message : `${message}: ${describeError(error)}`;
		this.append(`${new Date().toISOString()} [${level}] ${text}`);
	}

	private append(line: string): void {
		try {
			this.channel.appendLine(line);
		} catch {
			// The channel is closed; the line has nowhere to go.
		}
	}

	error(message: string, error?: unknown): void {
		this.write("error", message, error);
	}

	warn(message: string, error?: unknown): void {
		this.write("warn", message, error);
	}

	info(message: string, error?: unknown): void {
		this.write("info", message, error);
	}

	debug(message: string, error?: unknown): void {
		this.write("debug", message, error);
	}

	trace(direction: "in" | "out", frame: string): void {
		this.append(`${new Date().toISOString()} [trace] ${direction === "in" ? "<-" : "->"} ${frame}`);
	}
}
