import * as path from "node:path";
import type { AgentStatus, AgentView } from "../omp/api";
import type { TrackedChange } from "../vscode/ChangeTracker";

const AGENT_DESCRIPTION_MAX = 48;

/** Subagents by their OMP name (the last segment of a nested `Parent.Child` id); `main` unchanged. */
export function agentRowLabel(agent: AgentView): string {
	if (agent.id === "main") return agent.name;
	return agent.id.slice(agent.id.lastIndexOf(".") + 1) || agent.name;
}

/** Compact agent row description: `type · status · first line of activity`, truncated. */
export function agentRowDescription(agent: AgentView): string {
	const activity = agent.activity?.split("\n", 1)[0].trim();
	const parts = [agent.status as string];
	if (agentRowLabel(agent) !== agent.name) parts.unshift(agent.name);
	if (activity) parts.push(activity);
	const text = parts.join(" · ");
	return text.length > AGENT_DESCRIPTION_MAX ? `${text.slice(0, AGENT_DESCRIPTION_MAX - 1)}…` : text;
}

const AGENT_STATUS_ORDER: Record<AgentStatus, number> = { running: 0, pending: 1, completed: 2, failed: 2, aborted: 2 };

/** Running agents first, then pending; stable otherwise. */
export function sortAgents(agents: readonly AgentView[]): AgentView[] {
	return agents.slice().sort((a, b) => (AGENT_STATUS_ORDER[a.status] ?? 2) - (AGENT_STATUS_ORDER[b.status] ?? 2));
}

export function agentsSummary(agents: readonly AgentView[]): string {
	const running = agents.filter(agent => agent.status === "running").length;
	return running > 0 ? `${running} running` : "";
}

export function changesSummary(count: number): string {
	return count === 0 ? "" : `${count} ${count === 1 ? "file" : "files"}`;
}

/** `M · src/auth · +3 −1`; the directory is relative to `cwd` when known. */
export function changeRowDescription(change: TrackedChange, cwd: string | undefined): string {
	const dir = path.dirname(change.path);
	const relative = cwd ? path.relative(cwd, dir) : dir;
	const parts: string[] = [change.status];
	if (relative && relative !== ".") parts.push(relative);
	if (change.status !== "D") parts.push(`+${change.added} −${change.removed}`);
	return parts.join(" · ");
}
