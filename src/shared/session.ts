import type { SessionView } from "../omp/api";

/** The session as shown before OMP reported any state. */
export function emptySessionView(): SessionView {
	return {
		phase: "idle",
		availableThinkingLevels: [],
		isCompacting: false,
		queue: { steering: [], followUp: [] },
		todos: [],
		commands: [],
	};
}

/**
 * Options for the effort selector: the value is the user's selector (OMP `configured`),
 * and `auto` names the effort it resolved to once OMP classified the turn.
 */
export function effortChoices(session: Pick<SessionView, "availableThinkingLevels" | "thinkingSelector" | "thinkingLevel" | "thinkingResolved">): {
	value: string | undefined;
	options: Array<{ value: string; label: string }>;
} {
	const value = session.thinkingSelector ?? session.thinkingLevel;
	const options = session.availableThinkingLevels.map(level => ({
		value: level,
		label: level === "auto" && value === "auto" && session.thinkingResolved ? `auto · ${session.thinkingResolved}` : level,
	}));
	return { value, options };
}
