import * as assert from "node:assert/strict";
import type { AgentView, ModelView, TranscriptItem } from "../../../src/omp/api";
import {
	agentSummaryMarkdown,
	formatBytes,
	formatDuration,
	formatModelDetail,
	relativeTime,
	transcriptToMarkdown,
} from "../../../src/ui/format";

describe("format helpers", () => {
	it("formats relative time", () => {
		const now = 1_000_000_000;
		assert.equal(relativeTime(now - 5_000, now), "just now");
		assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
		assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
		assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
	});

	it("formats bytes and durations", () => {
		assert.equal(formatBytes(512), "512 B");
		assert.equal(formatBytes(2048), "2.0 KB");
		assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
		assert.equal(formatDuration(850), "850ms");
		assert.equal(formatDuration(12_300), "12.3s");
		assert.equal(formatDuration(125_000), "2m 5s");
	});

	it("formats a model detail line", () => {
		const model: ModelView = {
			provider: "anthropic",
			id: "claude",
			name: "Claude",
			contextWindow: 200_000,
			maxTokens: 64_000,
			reasoning: true,
			thinkingEfforts: ["low", "high"],
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		};
		assert.equal(formatModelDetail(model), "ctx 200k · out 64k · reasoning: low, high · in: text, image · $3/$15 per Mtok");
		assert.equal(
			formatModelDetail({ provider: "p", id: "m", name: "m", reasoning: false, thinkingEfforts: [], input: ["text"] }),
			"in: text",
		);
	});

	it("renders an agent summary", () => {
		const agent: AgentView = {
			id: "a1",
			parentId: "main",
			name: "scout",
			model: "m",
			status: "failed",
			activity: "read",
			tokens: 1200,
			costUsd: 0.0123,
			startedAt: 1000,
			endedAt: 4000,
			error: "boom",
		};
		const md = agentSummaryMarkdown(agent, 5000);
		assert.ok(md.startsWith("# scout"), md);
		for (const part of ["`a1`", "failed", "read", "1,200", "$0.0123", "3.0s", "boom"]) {
			assert.ok(md.includes(part), `${part} missing in ${md}`);
		}
	});

	it("renders a transcript as markdown", () => {
		const items: TranscriptItem[] = [
			{ kind: "user", id: "u", text: "hello" },
			{ kind: "assistant", id: "a", text: "hi", thinking: "hmm", streaming: false },
			{ kind: "tool", id: "t", name: "read", args: { path: "a.ts" }, status: "done", startedAt: 0, endedAt: 10, result: { text: "body", isError: false } },
			{ kind: "notice", id: "n", level: "error", text: "bad" },
		];
		const md = transcriptToMarkdown("Agent main", items);
		assert.ok(md.startsWith("# Agent main"));
		assert.ok(md.includes("## User\n\nhello"));
		assert.ok(md.includes("## Assistant\n\n> hmm\n\nhi"), md);
		assert.ok(md.includes("### Tool `read` — done"));
		assert.ok(md.includes("```\nbody\n```"));
		assert.ok(md.includes("**error:** bad"));
	});
});
