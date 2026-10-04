import * as assert from "node:assert/strict";
import type { ToolExecutionEvent, TranscriptItem } from "../../src/omp/api";
import type { AgentMessage, AssistantMessage, SessionEvent } from "../../src/omp/protocol";
import { historyToItems, SessionStore } from "../../src/omp/transcript";

const usage = (total: number) => ({
	input: 10,
	output: 5,
	cacheRead: 1,
	cacheWrite: 2,
	totalTokens: 18,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

function assistant(content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "a",
		provider: "p",
		model: "m1",
		usage: usage(0.01),
		stopReason: "stop",
		timestamp: 1,
		...extra,
	};
}

function store() {
	const s = new SessionStore();
	const changes: TranscriptItem[] = [];
	const tools: ToolExecutionEvent[] = [];
	s.onDidChangeItem(item => changes.push(item));
	s.onToolExecution(e => tools.push(e));
	return { s, changes, tools, apply: (e: object) => s.applyEvent(e as SessionEvent) };
}

describe("SessionStore transcript", () => {
	it("streams assistant text and thinking deltas keyed by messageId", () => {
		const { s, apply } = store();
		apply({ type: "message_start", messageId: "m-1", message: assistant([]) });
		apply({ type: "message_update", messageId: "m-1", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } });
		apply({ type: "message_update", messageId: "m-1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } });
		apply({ type: "message_update", messageId: "m-1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } });
		assert.deepEqual(s.transcript.map(i => ({ ...i })), [
			{ kind: "assistant", id: "m-1", text: "Hello", thinking: "hmm", streaming: true, model: "m1" },
		]);
		apply({ type: "message_update", messageId: "m-1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "Again" } });
		assert.equal(s.transcript[0].kind === "assistant" && s.transcript[0].text, "Hello\n\nAgain");
	});

	it("replaces streamed content with the full message on message_end and sums cost", () => {
		const { s, apply } = store();
		apply({ type: "message_start", messageId: "m-1", message: assistant([]) });
		apply({ type: "message_update", messageId: "m-1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
		apply({
			type: "message_end",
			messageId: "m-1",
			message: assistant([
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "Hello world" },
				{ type: "toolCall", id: "t1", name: "read", arguments: {} },
			]),
		});
		const item = s.transcript[0];
		assert.equal(item.kind, "assistant");
		if (item.kind !== "assistant") return;
		assert.equal(item.text, "Hello world");
		assert.equal(item.thinking, "plan");
		assert.equal(item.streaming, false);
		assert.equal(item.stopReason, "stop");
		assert.deepEqual(item.usage, { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, costUsd: 0.01 });
		assert.equal(s.session.costUsd, 0.01);
		apply({ type: "message_end", messageId: "m-2", message: assistant([{ type: "text", text: "x" }], { usage: usage(0.02) }) });
		assert.equal(s.session.costUsd, 0.03);
	});

	it("rebuilds from the full partial message when updates are not projected to deltas", () => {
		const { s, apply } = store();
		apply({
			type: "message_update",
			messageId: "m-9",
			message: assistant([{ type: "text", text: "Full so far" }]),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "far" },
		});
		assert.equal(s.transcript[0].kind === "assistant" && s.transcript[0].text, "Full so far");
	});

	it("records user messages and skips synthetic ones", () => {
		const { s, apply } = store();
		apply({ type: "message_start", messageId: "u-1", message: { role: "user", content: "hi", timestamp: 1 } });
		apply({ type: "message_end", messageId: "u-1", message: { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 1 } });
		apply({ type: "message_start", messageId: "u-2", message: { role: "user", content: "reminder", timestamp: 2, synthetic: true } });
		assert.deepEqual(s.transcript, [{ kind: "user", id: "u-1", text: "hi", imageCount: 1 }]);
	});

	it("tracks tool executions with partial output, results and details", () => {
		const { s, apply, tools } = store();
		apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { path: "a.ts" } });
		const started = s.transcript[0];
		assert.equal(started.kind === "tool" && started.status, "running");
		apply({ type: "tool_execution_update", toolCallId: "t1", toolName: "edit", partialResult: { content: [{ type: "text", text: "working" }] } });
		assert.equal(s.transcript[0].kind === "tool" && s.transcript[0].partial, "working");
		apply({ type: "tool_stream_update", toolCallId: "t1", toolName: "edit", update: "streamed" });
		assert.equal(s.transcript[0].kind === "tool" && s.transcript[0].partial, "streamed");
		apply({ type: "tool_stream_update", toolCallId: "t1", toolName: "edit", update: { files: [] } });
		assert.equal(s.transcript[0].kind === "tool" && s.transcript[0].partial, "streamed", "opaque stream payload keeps text");
		const details = { path: "a.ts", oldText: "x", newText: "y", diff: "-x\n+y" };
		apply({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "edit",
			result: { content: [{ type: "text", text: "Edited a.ts" }, { type: "text", text: "ok" }], details },
			isError: false,
		});
		const done = s.transcript[0];
		assert.equal(done.kind, "tool");
		if (done.kind !== "tool") return;
		assert.equal(done.status, "done");
		assert.deepEqual(done.result, { text: "Edited a.ts\nok", isError: false, details });
		assert.ok(done.endedAt! >= done.startedAt);
		assert.deepEqual(
			tools.map(t => [t.phase, t.toolCallId, t.name]),
			[
				["start", "t1", "edit"],
				["end", "t1", "edit"],
			],
		);
		assert.deepEqual(tools[0].args, { path: "a.ts" });
		assert.deepEqual(tools[1].result?.details, details);
	});

	it("marks failed tools as error", () => {
		const { s, apply } = store();
		apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		apply({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "exit 1" }] }, isError: true });
		assert.equal(s.transcript[0].kind === "tool" && s.transcript[0].status, "error");
	});

	it("keeps the auto selector apart from the effort it resolves to", () => {
		const { s, apply } = store();
		apply({ type: "thinking_level_changed", thinkingLevel: "high", configured: "auto" });
		assert.deepEqual([s.session.thinkingSelector, s.session.thinkingLevel, s.session.thinkingResolved], ["auto", "high", undefined]);
		apply({ type: "thinking_level_changed", thinkingLevel: "low", configured: "auto", resolved: "low" });
		assert.deepEqual([s.session.thinkingSelector, s.session.thinkingLevel, s.session.thinkingResolved], ["auto", "low", "low"]);
		apply({ type: "thinking_level_changed", thinkingLevel: "medium" });
		assert.deepEqual([s.session.thinkingSelector, s.session.thinkingLevel, s.session.thinkingResolved], ["medium", "medium", undefined]);
	});

	it("applies queue, thinking level, compaction, notices and retries", () => {
		const { s, apply } = store();
		apply({ type: "queue_update", steering: ["a"], followUp: ["b"] });
		assert.deepEqual(s.session.queue, { steering: ["a"], followUp: ["b"] });
		apply({ type: "thinking_level_changed", thinkingLevel: "high" });
		assert.equal(s.session.thinkingLevel, "high");
		apply({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
		assert.equal(s.session.isCompacting, true);
		apply({ type: "auto_compaction_end", action: "context-full", aborted: false, willRetry: false });
		assert.equal(s.session.isCompacting, false);
		apply({ type: "notice", level: "warning", message: "careful" });
		apply({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
		apply({ type: "auto_retry_end", success: false, attempt: 3, finalError: "gave up" });
		const notices = s.transcript.filter(i => i.kind === "notice");
		assert.deepEqual(
			notices.map(n => n.kind === "notice" && [n.level, n.text]),
			[
				["warning", "careful"],
				["warning", "Retrying (attempt 1/3) in 2s: overloaded"],
				["error", "Retry failed: gave up"],
			],
		);
		apply({ type: "agent_start" });
		assert.equal(s.session.isStreaming, true);
		apply({ type: "agent_end", messages: [] });
		assert.equal(s.session.isStreaming, false);
	});

	it("maps get_state into the session view", () => {
		const { s } = store();
		s.applyState({
			sessionId: "s1",
			sessionFile: "/x/s1.jsonl",
			sessionName: "Name",
			thinkingLevel: "low",
			fastModeEnabled: true,
			fastModeActive: false,
			isStreaming: false,
			isCompacting: false,
			queuedMessages: { steering: [], followUp: ["later"] },
			todoPhases: [{ name: "Todos", tasks: [{ content: "do it", status: "in_progress" }] }],
			contextUsage: { tokens: 1100, contextWindow: 200000, percent: 0.55 },
			model: {
				id: "m",
				name: "M",
				api: "x",
				provider: "p",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		});
		const v = s.session;
		assert.equal(v.sessionId, "s1");
		assert.equal(v.sessionFile, "/x/s1.jsonl");
		assert.equal(v.sessionName, "Name");
		assert.equal(v.model?.id, "m");
		assert.equal(v.thinkingLevel, "low");
		assert.equal(v.fastModeEnabled, true);
		assert.deepEqual(v.queue, { steering: [], followUp: ["later"] });
		assert.deepEqual(v.todos, [{ name: "Todos", tasks: [{ content: "do it", status: "in_progress" }] }]);
		assert.deepEqual(v.contextUsage, { tokens: 1100, contextWindow: 200000, percent: 0.55 });
	});

	it("adds command output and notice items", () => {
		const { s } = store();
		s.addCommandOutput("result");
		s.addNotice("error", "bad");
		assert.deepEqual(
			s.transcript.map(i => i.kind),
			["command_output", "notice"],
		);
	});
});

describe("historyToItems", () => {
	it("maps user, assistant, tool calls with results, and bash executions", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "fix it", timestamp: 1 },
			assistant([
				{ type: "text", text: "Reading" },
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "t2", name: "edit", arguments: { path: "a" } },
			]),
			{ role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 2 },
			{ role: "toolResult", toolCallId: "t2", toolName: "edit", content: [{ type: "text", text: "nope" }], isError: true, timestamp: 3, details: { path: "a" } },
			{ role: "developer", timestamp: 4 },
			{ role: "bashExecution", command: "ls", output: "a\nb", cancelled: false, truncated: false, timestamp: 5 },
		];
		const items = historyToItems(messages);
		assert.deepEqual(
			items.map(i => i.kind),
			["user", "assistant", "tool", "tool", "command_output"],
		);
		const [, a, t1, t2, out] = items;
		assert.equal(a.kind === "assistant" && a.text, "Reading");
		assert.ok(t1.kind === "tool" && t1.status === "done" && t1.result?.text === "contents");
		assert.ok(t2.kind === "tool" && t2.status === "error" && t2.result?.isError);
		assert.deepEqual(t2.kind === "tool" && t2.result?.details, { path: "a" });
		assert.equal(out.kind === "command_output" && out.text, "$ ls\na\nb");
		assert.equal(new Set(items.map(i => i.id)).size, items.length, "ids are unique");
	});

	it("resets the store transcript and cost from history", () => {
		const s = new SessionStore();
		let reset: readonly TranscriptItem[] | undefined;
		s.onDidReset(items => {
			reset = items;
		});
		s.reset([{ role: "user", content: "x", timestamp: 1 }, assistant([{ type: "text", text: "y" }])]);
		assert.equal(reset?.length, 2);
		assert.equal(s.session.costUsd, 0.01);
	});
});
