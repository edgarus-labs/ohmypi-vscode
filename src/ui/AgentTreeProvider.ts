import * as vscode from "vscode";
import type { AgentStatus, AgentView, Disposable, OmpServiceApi } from "../omp/api";
import { formatCost, formatDuration } from "./format";
import { agentRowDescription, agentRowLabel, agentsSummary, sortAgents } from "./treeRows";

const ICON_BY_STATUS: Record<AgentStatus, vscode.ThemeIcon> = {
	running: new vscode.ThemeIcon("sync~spin"),
	pending: new vscode.ThemeIcon("clock"),
	completed: new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed")),
	failed: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
	aborted: new vscode.ThemeIcon("circle-slash"),
};

/** `omp.agents`: the main agent at the root with subagents nested under their parent. */
export class AgentTreeProvider implements vscode.TreeDataProvider<AgentView>, vscode.Disposable {
	private agents: readonly AgentView[] = [];
	private subscription: Disposable | undefined;
	private readonly emitter = new vscode.EventEmitter<void>();
	private readonly summaryEmitter = new vscode.EventEmitter<string>();
	private lastSummary = "";
	readonly onDidChangeTreeData = this.emitter.event;
	/** Fires with the new {@link summary} when it changes. */
	readonly onDidChangeSummary = this.summaryEmitter.event;

	setService(service: OmpServiceApi | undefined): void {
		this.subscription?.dispose();
		this.subscription = service?.onDidChangeAgents(agents => this.update(agents));
		this.update(service?.agents ?? []);
	}

	private update(agents: readonly AgentView[]): void {
		this.agents = agents;
		this.emitter.fire();
		const summary = agentsSummary(agents);
		if (summary === this.lastSummary) return;
		this.lastSummary = summary;
		this.summaryEmitter.fire(summary);
	}

	/** View description, e.g. `2 running`; empty when nothing runs. */
	summary(): string {
		return this.lastSummary;
	}

	get current(): readonly AgentView[] {
		return this.agents;
	}

	find(id: string): AgentView | undefined {
		return this.agents.find(agent => agent.id === id);
	}

	/** Parent used for nesting: the declared parent when present, else main. */
	private parentOf(agent: AgentView): string | undefined {
		if (agent.id === "main") return undefined;
		const ids = new Set(this.agents.map(candidate => candidate.id));
		if (agent.parentId && agent.parentId !== agent.id && ids.has(agent.parentId)) return agent.parentId;
		return ids.has("main") ? "main" : undefined;
	}

	getChildren(element?: AgentView): AgentView[] {
		return sortAgents(this.agents.filter(agent => this.parentOf(agent) === element?.id));
	}

	getParent(element: AgentView): AgentView | undefined {
		const parent = this.parentOf(element);
		return parent === undefined ? undefined : this.find(parent);
	}

	getTreeItem(agent: AgentView): vscode.TreeItem {
		const hasChildren = this.agents.some(candidate => this.parentOf(candidate) === agent.id);
		const item = new vscode.TreeItem(
			agentRowLabel(agent),
			hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
		);
		// A new id once children appear, so VS Code applies Expanded instead of the remembered leaf state.
		item.id = hasChildren ? `${agent.id}/tree` : agent.id;
		item.description = agentRowDescription(agent);
		item.iconPath = ICON_BY_STATUS[agent.status] ?? new vscode.ThemeIcon("circle-outline");
		item.contextValue = agent.status === "running" || agent.status === "pending" ? "agent.running" : "agent.done";
		item.tooltip = this.tooltip(agent);
		item.command = { command: "omp.agent.openTranscript", title: "Open Agent Transcript", arguments: [agent] };
		return item;
	}

	private tooltip(agent: AgentView): vscode.MarkdownString {
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.supportHtml = false;
		tooltip.appendMarkdown(`**${agent.name}** \`${agent.id}\`\n\n`);
		const lines: string[] = [`status: ${agent.status}`];
		if (agent.model) lines.push(`model: ${agent.model}`);
		if (agent.description) lines.push(agent.description);
		if (agent.activity) lines.push(`activity: ${agent.activity}`);
		if (agent.toolCount !== undefined) lines.push(`tools: ${agent.toolCount}`);
		if (agent.tokens !== undefined) lines.push(`tokens: ${agent.tokens.toLocaleString("en-US")}`);
		if (agent.costUsd !== undefined) lines.push(`cost: ${formatCost(agent.costUsd)}`);
		if (agent.startedAt !== undefined) lines.push(`duration: ${formatDuration((agent.endedAt ?? Date.now()) - agent.startedAt)}`);
		if (agent.error) lines.push(`error: ${agent.error}`);
		for (const line of lines) tooltip.appendText(`${line}\n`);
		return tooltip;
	}

	dispose(): void {
		this.subscription?.dispose();
		this.emitter.dispose();
		this.summaryEmitter.dispose();
	}
}
