import type { AgentStatus, AgentView, SessionPhase } from "./api";
import { Emitter } from "./emitter";
import type { SubagentFrame, SubagentProgress, SubagentSnapshot } from "./protocol";

export interface MainAgentState {
	phase: SessionPhase;
	/** `provider/id` of the session model. */
	model?: string;
	/** Running tool name. */
	activity?: string;
}

/** Nested subagent ids are dotted (`Anna.Bob`); top-level ones belong to the main agent. */
function parentOf(id: string): string {
	const dot = id.lastIndexOf(".");
	return dot === -1 ? "main" : id.slice(0, dot);
}

function activityOf(progress: SubagentProgress | undefined): string | undefined {
	if (!progress) return undefined;
	if (progress.currentTool) return progress.currentTool;
	if (progress.lastIntent) return progress.lastIntent;
	return progress.recentOutput?.at(-1);
}

/** Applies a progress record; a finished agent (`endedAt` set) only takes its counters, model and error. */
function withProgress(view: AgentView, progress: SubagentProgress | undefined): AgentView {
	if (!progress) return view;
	const next: AgentView = { ...view };
	const ended = next.endedAt !== undefined;
	if (progress.status && !ended) next.status = progress.status as AgentStatus;
	if (progress.description) next.description = progress.description;
	if (progress.resolvedModel) next.model = progress.resolvedModel;
	if (progress.toolCount !== undefined) next.toolCount = progress.toolCount;
	if (progress.tokens !== undefined) next.tokens = progress.tokens;
	if (progress.cost !== undefined) next.costUsd = progress.cost;
	const error = progress.error || progress.retryFailure?.errorMessage;
	if (error) next.error = error;
	else if (!ended) delete next.error;
	const activity = activityOf(progress);
	if (activity && (next.status === "running" || next.status === "pending")) next.activity = activity;
	else delete next.activity;
	return next;
}

function sameView(a: AgentView, b: AgentView): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AgentView>;
	for (const key of keys) if (a[key] !== b[key]) return false;
	return true;
}

/**
 * The session's own agent plus its subagents, fed by `get_subagents` snapshots
 * and `subagent_lifecycle`/`subagent_progress` frames.
 */
export class AgentRegistry {
	#main: AgentView = { id: "main", name: "main", status: "completed" };
	readonly #subagents = new Map<string, AgentView>();
	#agents: readonly AgentView[] = [this.#main];
	readonly #change: Emitter<readonly AgentView[]>;
	readonly onDidChange;

	constructor(onListenerError?: (error: unknown) => void) {
		this.#change = new Emitter<readonly AgentView[]>(onListenerError);
		this.onDidChange = this.#change.event;
	}

	get agents(): readonly AgentView[] {
		return this.#agents;
	}

	setMain(state: MainAgentState): void {
		const main: AgentView = { id: "main", name: "main", status: state.phase === "idle" ? "completed" : "running" };
		if (state.model) main.model = state.model;
		if (state.activity && main.status === "running") main.activity = state.activity;
		if (sameView(main, this.#main)) return;
		this.#main = main;
		this.#publish();
	}

	/** Merge a `get_subagents` snapshot; finished agents already shown are kept. */
	applySnapshot(subagents: readonly SubagentSnapshot[]): void {
		for (const snapshot of subagents) {
			const existing = this.#subagents.get(snapshot.id);
			let view: AgentView = {
				...existing,
				id: snapshot.id,
				parentId: parentOf(snapshot.id),
				name: snapshot.agent,
				status: snapshot.status,
			};
			const description = snapshot.description ?? snapshot.task;
			if (description) view.description = description;
			if (snapshot.sessionFile) view.sessionFile = snapshot.sessionFile;
			if (view.startedAt === undefined) view.startedAt = snapshot.lastUpdate - (snapshot.progress?.durationMs ?? 0);
			if (snapshot.status === "running" || snapshot.status === "pending") delete view.endedAt;
			else view.endedAt ??= snapshot.lastUpdate;
			view = withProgress(view, snapshot.progress);
			this.#subagents.set(snapshot.id, view);
		}
		this.#publish();
	}

	applyFrame(frame: SubagentFrame): void {
		if (frame.type === "subagent_lifecycle") {
			const payload = frame.payload;
			const existing = this.#subagents.get(payload.id);
			if (!existing && payload.status !== "started") return;
			const view: AgentView = {
				...existing,
				id: payload.id,
				parentId: parentOf(payload.id),
				name: payload.agent,
				status: payload.status === "started" ? "running" : payload.status,
			};
			if (payload.description) view.description = payload.description;
			if (payload.sessionFile) view.sessionFile = payload.sessionFile;
			if (payload.status === "started") {
				view.startedAt ??= Date.now();
				delete view.endedAt;
			} else {
				view.endedAt = Date.now();
				delete view.activity;
			}
			this.#subagents.set(payload.id, view);
			this.#publish();
			return;
		}
		if (frame.type === "subagent_progress") {
			const { progress, sessionFile } = frame.payload;
			const id = progress.id;
			const existing = id === undefined ? undefined : this.#subagents.get(id);
			if (!existing || id === undefined) return;
			const view = withProgress({ ...existing, ...(sessionFile ? { sessionFile } : {}) }, progress);
			if (sameView(view, existing)) return;
			this.#subagents.set(id, view);
			this.#publish();
		}
	}

	clearSubagents(): void {
		if (this.#subagents.size === 0) return;
		this.#subagents.clear();
		this.#publish();
	}

	/** The process running the subagents went away: those still running or pending end as `failed` with `reason`. */
	interruptSubagents(reason: string): void {
		let changed = false;
		for (const [id, agent] of this.#subagents) {
			if (agent.status !== "running" && agent.status !== "pending") continue;
			const failed: AgentView = { ...agent, status: "failed", endedAt: Date.now(), error: reason };
			delete failed.activity;
			this.#subagents.set(id, failed);
			changed = true;
		}
		if (changed) this.#publish();
	}

	dispose(): void {
		this.#change.dispose();
	}

	#publish(): void {
		this.#agents = [this.#main, ...this.#subagents.values()];
		this.#change.fire(this.#agents);
	}
}
