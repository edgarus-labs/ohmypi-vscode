import type { ConnectionState, SessionPhase, SessionView, TodoPhaseView } from "../omp/api";
import { formatCost } from "../shared/format";

export type StateWord = "idle" | "working" | "waiting" | "aborting" | "starting" | "offline";

export function stateWord(input: { connection: ConnectionState; phase: SessionPhase; pendingInteractions: number; unavailable: boolean }): StateWord {
	if (input.unavailable || input.connection === "stopped" || input.connection === "failed") return "offline";
	if (input.connection !== "ready") return "starting";
	if (input.pendingInteractions > 0) return "waiting";
	if (input.phase === "aborting") return "aborting";
	return input.phase === "idle" ? "idle" : "working";
}

/** `todos 2/5 · current: <task in progress>`; undefined when there are no tasks. */
export function todoSummary(phases: readonly TodoPhaseView[]): string | undefined {
	const tasks = phases.flatMap(phase => phase.tasks);
	if (tasks.length === 0) return undefined;
	const done = tasks.filter(task => task.status === "completed").length;
	const current = tasks.find(task => task.status === "in_progress");
	const summary = `todos ${done}/${tasks.length}`;
	return current ? `${summary} · current: ${current.content.replace(/\s+/g, " ").trim()}` : summary;
}

/** `ctx 13% · $0.0215`, omitting unknown parts. */
export function usageText(session: Pick<SessionView, "contextUsage" | "costUsd">): string {
	const parts: string[] = [];
	if (session.contextUsage) parts.push(`ctx ${Math.round(session.contextUsage.percent)}%`);
	if (session.costUsd !== undefined) parts.push(formatCost(session.costUsd));
	return parts.join(" · ");
}

/** What the round primary button does: send when idle; while busy, steer with typed content, else stop. */
export function composerAction(input: { busy: boolean; hasContent: boolean }): "send" | "steer" | "stop" {
	if (!input.busy) return "send";
	return input.hasContent ? "steer" : "stop";
}

/** Whether a scroll container shows its last pixels (within `threshold`). */
export function isAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 24): boolean {
	return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** `1 line` / `12 lines`. */
export function lineCount(text: string): string {
	const lines = text.split("\n").length;
	return `${lines} line${lines === 1 ? "" : "s"}`;
}
