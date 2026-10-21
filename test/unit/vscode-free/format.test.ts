import * as assert from "node:assert/strict";
import type { AgentView, TranscriptItem } from "../../../src/omp/api";
import { agentSummaryMarkdown, formatBytes, sessionTitle, transcriptToMarkdown } from "../../../src/ui/format";

describe("format helpers", () => {
	it("titles a session by title, first message, or file name without extension", () => {
		const file = "/s/2026-10-04_abc.jsonl";
		assert.equal(sessionTitle({ title: "  Fix\n login  ", firstMessage: "ignored", path: file }), "Fix login");
		assert.equal(sessionTitle({ firstMessage: "hello\n\nworld", path: file }), "hello world");
		assert.equal(sessionTitle({ title: " ", firstMessage: "x".repeat(150), path: file }), "x".repeat(150));
		assert.equal(sessionTitle({ title: "", firstMessage: "", path: file }), "2026-10-04_abc");
	});

	it("formats bytes", () => {
		assert.equal(formatBytes(512), "512 B");
		assert.equal(formatBytes(2048), "2.0 KB");
		assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
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

	it("keeps every agent summary field on one table row", () => {
		const md = agentSummaryMarkdown({ id: "a1", name: "scout", status: "failed", error: "one\rtwo\r\nthree\nfour|five" }, 0);
		assert.ok(md.includes("| error | one two three four\\|five |"), JSON.stringify(md));
		assert.ok(!md.includes("\r"), JSON.stringify(md));
		assert.ok(agentSummaryMarkdown({ id: "a1", name: "scout\r\nx", status: "failed" }, 0).startsWith("# scout x\n\n| field"));
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

	it("renders a turn summary as one italic line", () => {
		const md = transcriptToMarkdown("Agent main", [
			{ kind: "assistant", id: "a", text: "done", thinking: "", streaming: false },
			{ kind: "turn_summary", id: "s", status: "aborted", durationMs: 12_000, usage: { input: 1_200, output: 300, cacheRead: 0, cacheWrite: 0, costUsd: 0.0123 } },
		]);
		assert.ok(md.endsWith("done\n\n_Stopped after 12s · 1.2k in · 300 out · $0.0123_\n"), md);
	});
});
