import * as vscode from "vscode";
import type { Logger } from "../omp/api";

type Level = "error" | "warn" | "info" | "debug";
const RANK: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function describeError(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}

/** Output-channel logger filtered by `omp.logLevel`; RPC frames only when `omp.traceRpc` is on. Settings are read live. */
export class OutputLogger implements Logger {
	constructor(private readonly channel: vscode.OutputChannel) {}

	private write(level: Level, message: string): void {
		const configured = vscode.workspace.getConfiguration("omp").get<Level>("logLevel", "info");
		if (RANK[level] > (RANK[configured] ?? RANK.info)) return;
		this.channel.appendLine(`${new Date().toISOString()} [${level}] ${message}`);
	}

	error(message: string, error?: unknown): void {
		this.write("error", error === undefined ? message : `${message}: ${describeError(error)}`);
	}

	warn(message: string): void {
		this.write("warn", message);
	}

	info(message: string): void {
		this.write("info", message);
	}

	debug(message: string): void {
		this.write("debug", message);
	}

	trace(direction: "in" | "out", frame: string): void {
		if (!vscode.workspace.getConfiguration("omp").get<boolean>("traceRpc", false)) return;
		this.channel.appendLine(`${new Date().toISOString()} [trace] ${direction === "in" ? "<-" : "->"} ${frame}`);
	}
}
