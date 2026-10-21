import type { SessionSummary } from "../omp/api";
import type { RecentSession } from "../webview/protocol";
import { sessionTitle } from "./format";

const RECENT_SESSION_LIMIT = 5;

/** The newest saved sessions other than `currentFile` (`summaries` newest first) and how many there are. */
export function recentSessions(summaries: readonly SessionSummary[], currentFile: string | undefined): { sessions: RecentSession[]; total: number } {
	const others = summaries.filter(summary => summary.path !== currentFile);
	return {
		sessions: others.slice(0, RECENT_SESSION_LIMIT).map(summary => ({ path: summary.path, title: sessionTitle(summary), modified: summary.modified })),
		total: others.length,
	};
}
