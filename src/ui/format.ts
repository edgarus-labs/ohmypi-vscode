import type { AgentView, ModelView, TranscriptItem } from "../omp/api";

export function relativeTime(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	return `${Math.floor(total / 60)}m ${total % 60}s`;
}

export function compactTokens(value: number): string {
	if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${+(value / 1000).toFixed(1)}k`;
	return String(value);
}

export function formatModelDetail(model: ModelView): string {
	const parts: string[] = [];
	if (model.contextWindow) parts.push(`ctx ${compactTokens(model.contextWindow)}`);
	if (model.maxTokens) parts.push(`out ${compactTokens(model.maxTokens)}`);
	if (model.thinkingEfforts.length > 0) parts.push(`reasoning: ${model.thinkingEfforts.join(", ")}`);
	else if (model.reasoning) parts.push("reasoning");
	if (model.input.length > 0) parts.push(`in: ${model.input.join(", ")}`);
	if (model.cost && (model.cost.input > 0 || model.cost.output > 0)) {
		parts.push(`$${+model.cost.input.toFixed(4)}/$${+model.cost.output.toFixed(4)} per Mtok`);
	}
	return parts.join(" · ");
}

export function formatCost(usd: number): string {
	return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function agentSummaryMarkdown(agent: AgentView, now: number): string {
	const rows: Array<[string, string | undefined]> = [
		["id", `\`${agent.id}\``],
		["parent", agent.parentId && `\`${agent.parentId}\``],
		["status", agent.status],
		["model", agent.model],
		["description", agent.description],
		["activity", agent.activity],
		["tools", agent.toolCount?.toString()],
		["tokens", agent.tokens?.toLocaleString("en-US")],
		["cost", agent.costUsd === undefined ? undefined : formatCost(agent.costUsd)],
		["duration", agent.startedAt === undefined ? undefined : formatDuration((agent.endedAt ?? now) - agent.startedAt)],
		["session file", agent.sessionFile && `\`${agent.sessionFile}\``],
		["error", agent.error],
	];
	const lines = [`# ${agent.name}`, "", "| field | value |", "| --- | --- |"];
	for (const [field, value] of rows) {
		if (value) lines.push(`| ${field} | ${value.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
	}
	return `${lines.join("\n")}\n`;
}

/** Markdown fence longer than any backtick run inside `text`. */
export function fenceFor(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
	return "`".repeat(Math.max(3, longest + 1));
}

function fenced(text: string): string {
	const fence = fenceFor(text);
	return `${fence}\n${text}\n${fence}`;
}

export function transcriptToMarkdown(title: string, items: readonly TranscriptItem[]): string {
	const blocks = [`# ${title}`];
	for (const item of items) {
		switch (item.kind) {
			case "user":
				blocks.push(`## User\n\n${item.text}`);
				break;
			case "assistant": {
				const parts = [`## Assistant${item.model ? ` (${item.model})` : ""}`];
				if (item.thinking) parts.push(item.thinking.split("\n").map(line => `> ${line}`).join("\n"));
				if (item.text) parts.push(item.text);
				if (item.errorMessage) parts.push(`**error:** ${item.errorMessage}`);
				blocks.push(parts.join("\n\n"));
				break;
			}
			case "tool": {
				const parts = [`### Tool \`${item.name}\` — ${item.status}`, fenced(JSON.stringify(item.args ?? null, null, 2))];
				const output = item.result?.text ?? item.partial;
				if (output) parts.push(fenced(output));
				blocks.push(parts.join("\n\n"));
				break;
			}
			case "notice":
				blocks.push(`**${item.level}:** ${item.text}`);
				break;
			case "command_output":
				blocks.push(fenced(item.text));
				break;
		}
	}
	return `${blocks.join("\n\n")}\n`;
}
