import type { TranscriptItem, TurnStatus } from "../omp/api";

export function formatCost(usd: number): string {
	return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** `850ms`, `12.3s`, `2m 5s`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** `12s`, `1m 05s`, `1h 02m`: the ticking time of a turn. */
export function elapsedText(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const pad = (value: number) => String(value).padStart(2, "0");
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
	return `${Math.floor(seconds / 3600)}h ${pad(Math.floor(seconds / 60) % 60)}m`;
}

/** `950`, `12.3k`, `8k`, `2.5M`. */
export function compactTokens(value: number): string {
	if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${+(value / 1000).toFixed(1)}k`;
	return String(value);
}

const TURN_ENDING: Record<TurnStatus, [alone: string, timed: string]> = {
	completed: ["Worked", "Worked"],
	aborted: ["Stopped", "Stopped after"],
	error: ["Failed", "Failed after"],
};

/** `Worked 1m 12s · 12.3k in · 2.1k out · 8k cached · 1.5k cache write · $0.0123`, leaving out zero and unknown parts. */
export function turnSummaryText(item: Extract<TranscriptItem, { kind: "turn_summary" }>): string {
	const [alone, timed] = TURN_ENDING[item.status];
	const parts = [item.durationMs === undefined ? alone : `${timed} ${elapsedText(item.durationMs)}`];
	const { usage } = item;
	if (usage.input > 0) parts.push(`${compactTokens(usage.input)} in`);
	if (usage.output > 0) parts.push(`${compactTokens(usage.output)} out`);
	if (usage.cacheRead > 0) parts.push(`${compactTokens(usage.cacheRead)} cached`);
	if (usage.cacheWrite > 0) parts.push(`${compactTokens(usage.cacheWrite)} cache write`);
	if (usage.costUsd !== undefined && usage.costUsd > 0) parts.push(formatCost(usage.costUsd));
	return parts.join(" · ");
}

/** Compact age of a timestamp: `now`, `5m`, `3h`, `2d`, `1w`, `4mo`, `1y`. */
export function relativeTime(epochMs: number, now: number): string {
	const minutes = Math.floor((now - epochMs) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.min(11, Math.floor(days / 30))}mo`;
	return `${Math.floor(days / 365)}y`;
}

/** Markdown fence longer than any backtick run inside `text`. */
export function fenceFor(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
	return "`".repeat(Math.max(3, longest + 1));
}
