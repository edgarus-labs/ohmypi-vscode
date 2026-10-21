import * as path from "node:path";
import type { AgentView, SessionSummary, TranscriptItem } from "../omp/api";
import { fenceFor, formatCost, formatDuration, turnSummaryText } from "../shared/format";

/** Display title of a saved session: its title, else its first message, else its file name; whitespace collapsed. */
export function sessionTitle(session: Pick<SessionSummary, "title" | "firstMessage" | "path">): string {
	const [title, firstMessage] = [session.title, session.firstMessage].map(text => text?.replace(/\s+/g, " ").trim());
	return title || firstMessage || path.basename(session.path, ".jsonl");
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const LINE_BREAK = /\r\n|\r|\n/g;

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
	const lines = [`# ${agent.name.replace(LINE_BREAK, " ")}`, "", "| field | value |", "| --- | --- |"];
	for (const [field, value] of rows) {
		if (value) lines.push(`| ${field} | ${value.replace(/\|/g, "\\|").replace(LINE_BREAK, " ")} |`);
	}
	return `${lines.join("\n")}\n`;
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
				if (item.thinking)
					parts.push(
						item.thinking
							.split("\n")
							.map(line => `> ${line}`)
							.join("\n"),
					);
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
			case "turn_summary":
				blocks.push(`_${turnSummaryText(item)}_`);
				break;
		}
	}
	return `${blocks.join("\n\n")}\n`;
}
