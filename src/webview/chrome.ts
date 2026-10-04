import type { ConnectionState, SessionPhase, SessionView, TodoPhaseView } from "../omp/api";

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

export function formatCost(usd: number): string {
	return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** `ctx 13% · $0.0215`, omitting unknown parts. */
export function usageText(session: Pick<SessionView, "contextUsage" | "costUsd">): string {
	const parts: string[] = [];
	if (session.contextUsage) parts.push(`ctx ${Math.round(session.contextUsage.percent)}%`);
	if (session.costUsd !== undefined) parts.push(formatCost(session.costUsd));
	return parts.join(" · ");
}

export function elapsedText(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const pad = (value: number) => String(value).padStart(2, "0");
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
	return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`;
}

/**
 * Options for the effort selector: the value is the user's selector (OMP `configured`),
 * and `auto` names the effort it resolved to once OMP classified the turn.
 */
export function effortChoices(
	session: Pick<SessionView, "availableThinkingLevels" | "thinkingSelector" | "thinkingLevel" | "thinkingResolved">,
): { value: string | undefined; options: Array<{ value: string; label: string }> } {
	const value = session.thinkingSelector ?? session.thinkingLevel;
	const options = session.availableThinkingLevels.map(level => ({
		value: level,
		label: level === "auto" && value === "auto" && session.thinkingResolved ? `auto · ${session.thinkingResolved}` : level,
	}));
	return { value, options };
}

/** Whether a scroll container shows its last pixels (within `threshold`). */
export function isAtBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 24): boolean {
	return scrollHeight - scrollTop - clientHeight <= threshold;
}
