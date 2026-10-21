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
		apply({
			type: "message_update",
			messageId: "m-1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
		});
		apply({
			type: "message_update",
			messageId: "m-1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" },
		});
		apply({
			type: "message_update",
			messageId: "m-1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" },
		});
		assert.deepEqual(
			s.transcript.map(i => ({ ...i })),
			[{ kind: "assistant", id: "m-1", text: "Hello", thinking: "hmm", streaming: true, model: "m1" }],
		);
		apply({
			type: "message_update",
			messageId: "m-1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "Again" },
		});
		assert.equal(s.transcript[0].kind === "assistant" && s.transcript[0].text, "Hello\n\nAgain");
	});

	it("replaces streamed content with the full message on message_end and sums cost", () => {
		const { s, apply } = store();
		apply({ type: "message_start", messageId: "m-1", message: assistant([]) });
		apply({
			type: "message_update",
			messageId: "m-1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
		});
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
		apply({
			type: "message_end",
			messageId: "u-1",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "hi" },
					{ type: "image", data: "", mimeType: "image/png" },
				],
				timestamp: 1,
			},
		});
		apply({ type: "message_start", messageId: "u-2", message: { role: "user", content: "reminder", timestamp: 2, synthetic: true } });
		assert.deepEqual(s.transcript, [{ kind: "user", id: "u-1", text: "hi", imageCount: 1 }]);
	});

	it("records a user message without messageId once across start and end", () => {
		const { s, apply } = store();
		apply({ type: "message_start", message: { role: "user", content: "hi", timestamp: 1 } });
		apply({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } });
		apply({ type: "message_start", message: { role: "user", content: "again", timestamp: 2 } });
		apply({ type: "message_end", message: { role: "user", content: "again", timestamp: 2 } });
		assert.deepEqual(
			s.transcript.map(i => i.kind === "user" && i.text),
			["hi", "again"],
		);
	});

	it("tracks tool executions with partial output, results and details", () => {
		const { s, apply, tools } = store();
		apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { path: "a.ts" } });
		const started = s.transcript[0];
		assert.equal(started.kind === "tool" && started.status, "running");
		apply({ type: "tool_execution_update", toolCallId: "t1", toolName: "edit", partialResult: { content: [{ type: "text", text: "working" }] } });
		assert.equal(s.transcript[0].kind === "tool" && s.transcript[0].partial, "working");
		apply({ type: "tool_stream_update", toolCallId: "t1", toolName: "edit", update: { streaming: true, files: [{ path: "a.ts" }] } });
		assert.equal(s.transcript[0].kind === "tool" && s.transcript[0].partial, "working", "argument previews are not tool output");
		const details = { path: "a.ts", oldText: "x", newText: "y", diff: "-x\n+y" };
		apply({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "edit",
			result: {
				content: [
					{ type: "text", text: "Edited a.ts" },
					{ type: "text", text: "ok" },
				],
				details,
			},
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

	it("ignores argument previews streamed before the tool starts", () => {
		const { s, apply, changes } = store();
		apply({ type: "tool_stream_update", toolCallId: "t1", toolName: "edit", update: { streaming: false, files: [{ path: "a.ts" }] } });
		assert.deepEqual([s.transcript, changes], [[], []]);
	});

	it("shows a reloaded call that reports progress as running", () => {
		const { s, apply } = store();
		s.reset([assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], { stopReason: "toolUse" })]);
		apply({ type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "line" }] } });
		const tool = s.transcript.find(item => item.id === "t1");
		assert.deepEqual(tool?.kind === "tool" && [tool.status, tool.partial], ["running", "line"]);
		assert.equal(s.runningTool, "bash");
	});

	it("closes streaming replies and running tools when the session is interrupted", () => {
		const { s, apply } = store();
		apply({ type: "message_start", messageId: "m-1", message: assistant([]) });
		apply({
			type: "message_update",
			messageId: "m-1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hal" },
		});
		apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		apply({ type: "tool_execution_update", toolCallId: "t1", toolName: "bash", partialResult: { content: [{ type: "text", text: "half" }] } });
		apply({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} });
		apply({ type: "tool_execution_end", toolCallId: "t2", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
		const finished = s.transcript.find(item => item.id === "t2");
		s.interrupt("OMP process exited (code 3)");
		const [reply, interrupted] = s.transcript;
		assert.deepEqual(reply.kind === "assistant" && [reply.text, reply.streaming], ["Hal", false]);
		assert.equal(interrupted.kind, "tool");
		if (interrupted.kind !== "tool") return;
		assert.equal(interrupted.status, "error");
		assert.deepEqual(interrupted.result, { text: "Interrupted: OMP process exited (code 3)", isError: true });
		assert.equal(interrupted.partial, "half");
		assert.ok(interrupted.endedAt !== undefined);
		assert.equal(
			s.transcript.find(item => item.id === "t2"),
			finished,
		);
		assert.equal(s.runningTool, undefined);
	});

	it("leaves an idle transcript untouched when interrupted", () => {
		const { s, apply, changes } = store();
		apply({ type: "message_end", messageId: "m-1", message: assistant([{ type: "text", text: "done" }]) });
		const before = changes.length;
		s.interrupt("OMP was stopped");
		assert.equal(changes.length, before);
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
		apply({ type: "agent_end", messages: [] });
		s.applyState({ sessionId: "s1", isStreaming: true });
		assert.ok(!("isStreaming" in s.session), "phase is the only busy signal");
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
			{
				role: "toolResult",
				toolCallId: "t2",
				toolName: "edit",
				content: [{ type: "text", text: "nope" }],
				isError: true,
				timestamp: 3,
				details: { path: "a" },
			},
			{ role: "developer", timestamp: 4 },
			{ role: "bashExecution", command: "ls", output: "a\nb", cancelled: false, truncated: false, timestamp: 5 },
		];
		const items = historyToItems(messages);
		assert.deepEqual(
			items.map(i => i.kind),
			["user", "assistant", "tool", "tool", "turn_summary", "command_output"],
		);
		const [, a, t1, t2, , out] = items;
		assert.equal(a.kind === "assistant" && a.text, "Reading");
		assert.ok(t1.kind === "tool" && t1.status === "done" && t1.result?.text === "contents");
		assert.ok(t2.kind === "tool" && t2.status === "error" && t2.result?.isError);
		assert.deepEqual(t2.kind === "tool" && t2.result?.details, { path: "a" });
		assert.equal(out.kind === "command_output" && out.text, "$ ls\na\nb");
		assert.equal(new Set(items.map(i => i.id)).size, items.length, "ids are unique");
	});

	it("marks a stored tool call without a result as unresolved, not failed", () => {
		const items = historyToItems([assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 100" } }], { timestamp: 7 })]);
		assert.deepEqual(items[1], { kind: "tool", id: "t1", name: "bash", args: { command: "sleep 100" }, status: "unresolved", startedAt: 7 });
	});

	it("shows the unresolved calls of a running agent's last reply as running", () => {
		const messages: AgentMessage[] = [
			assistant([{ type: "toolCall", id: "t1", name: "read", arguments: {} }], { stopReason: "toolUse" }),
			assistant([{ type: "toolCall", id: "t2", name: "bash", arguments: {} }], { stopReason: "toolUse" }),
		];
		const statuses = (items: TranscriptItem[]) => items.flatMap(item => (item.kind === "tool" ? [item.status] : []));
		assert.deepEqual(statuses(historyToItems(messages, { running: true })), ["unresolved", "running"]);
		assert.deepEqual(statuses(historyToItems(messages)), ["unresolved", "unresolved"]);
	});

	it("shows where the conversation was compacted", () => {
		const items = historyToItems([
			{ role: "compactionSummary", summary: "Long summary", shortSummary: "Fixed the parser", tokensBefore: 90_000, timestamp: 1 },
			{ role: "user", content: "next", timestamp: 2 },
		]);
		assert.deepEqual(items[0], { kind: "notice", id: "h0", level: "info", text: "Earlier messages were compacted into a summary: Fixed the parser" });
		const long = historyToItems([{ role: "compactionSummary", summary: "Long summary", tokensBefore: 1, timestamp: 1 }]);
		assert.equal(long[0].kind === "notice" && long[0].text, "Earlier messages were compacted into a summary: Long summary");
	});

	it("resets the store transcript and cost from history", () => {
		const s = new SessionStore();
		let reset: readonly TranscriptItem[] | undefined;
		s.onDidReset(items => {
			reset = items;
		});
		s.reset([{ role: "user", content: "x", timestamp: 1 }, assistant([{ type: "text", text: "y" }])]);
		assert.deepEqual(
			reset?.map(item => item.kind),
			["user", "assistant", "turn_summary"],
		);
		assert.equal(s.session.costUsd, 0.01);
	});
});

describe("SessionStore pending user items", () => {
	const userMessage = (text: string) => ({ role: "user", content: text, timestamp: 1 });
	const users = (items: readonly TranscriptItem[]) => items.filter(item => item.kind === "user").map(item => ({ ...item }));

	it("shows a pending item at once and lets the next OMP user message replace it in place", () => {
		const { s, changes, apply } = store();
		apply({ type: "message_end", messageId: "a-0", message: assistant([{ type: "text", text: "earlier" }]) });
		const id = s.addPendingUser("hi", 1);
		assert.deepEqual(changes.at(-1), { kind: "user", id, text: "hi", imageCount: 1, pending: true });
		apply({ type: "message_start", messageId: "u-1", message: userMessage("<editor-context>x</editor-context>\n\nhi") });
		apply({ type: "message_end", messageId: "u-1", message: userMessage("<editor-context>x</editor-context>\n\nhi") });
		assert.deepEqual(
			s.transcript.map(item => item.id),
			["a-0", id],
		);
		assert.deepEqual(users(s.transcript), [{ kind: "user", id, text: "<editor-context>x</editor-context>\n\nhi" }]);
	});

	it("matches pending items to OMP user messages in FIFO order", () => {
		const { s, apply } = store();
		const first = s.addPendingUser("one", 0);
		const second = s.addPendingUser("two", 0);
		apply({ type: "message_start", messageId: "u-1", message: userMessage("one") });
		apply({ type: "message_end", messageId: "u-1", message: userMessage("one") });
		assert.deepEqual(users(s.transcript), [
			{ kind: "user", id: first, text: "one" },
			{ kind: "user", id: second, text: "two", pending: true },
		]);
		apply({ type: "message_start", message: userMessage("two") });
		assert.deepEqual(users(s.transcript), [
			{ kind: "user", id: first, text: "one" },
			{ kind: "user", id: second, text: "two" },
		]);
		apply({ type: "message_start", messageId: "u-3", message: userMessage("three") });
		assert.deepEqual(
			users(s.transcript).map(item => item.text),
			["one", "two", "three"],
		);
	});

	it("keeps a typed slash command visible and carries the text OMP expanded it to", () => {
		const { s, apply } = store();
		const id = s.addPendingUser("/review src", 0);
		apply({ type: "message_start", messageId: "u-1", message: userMessage("Review the code in src.") });
		assert.deepEqual(users(s.transcript), [{ kind: "user", id, text: "/review src", expandedText: "Review the code in src." }]);
	});

	it("keeps a pending item OMP never recorded once its prompt completes, no longer pending", () => {
		const { s, changes } = store();
		const id = s.addPendingUser("/rules", 0);
		s.confirmPendingUser(id);
		assert.deepEqual(users(s.transcript), [{ kind: "user", id, text: "/rules" }]);
		assert.deepEqual(changes.at(-1), { kind: "user", id, text: "/rules" });
		s.addCommandOutput("rules: none");
		assert.deepEqual(
			s.transcript.map(item => item.kind),
			["user", "command_output"],
		);
	});

	it("removes a pending item whose prompt OMP never admitted and resets the transcript", () => {
		const { s, apply } = store();
		apply({ type: "message_end", messageId: "a-0", message: assistant([{ type: "text", text: "earlier" }]) });
		const id = s.addPendingUser("lost", 0);
		let reset: string[] | undefined;
		s.onDidReset(items => {
			reset = items.map(item => item.id);
		});
		s.removePendingUser(id);
		assert.deepEqual(reset, ["a-0"]);
		assert.deepEqual(
			s.transcript.map(item => item.id),
			["a-0"],
		);
		s.addNotice("info", "after");
		assert.deepEqual(
			s.transcript.map(item => item.kind),
			["assistant", "notice"],
		);
	});

	it("leaves reconciled items alone when asked to remove or confirm them", () => {
		const { s, apply } = store();
		const id = s.addPendingUser("hi", 0);
		apply({ type: "message_start", messageId: "u-1", message: userMessage("hi") });
		s.removePendingUser(id);
		s.confirmPendingUser(id);
		assert.deepEqual(users(s.transcript), [{ kind: "user", id, text: "hi" }]);
	});

	it("keeps still-pending items after a history reset and drops the rest", () => {
		const { s, apply } = store();
		const kept = s.addPendingUser("/rules", 0);
		s.confirmPendingUser(kept);
		const waiting = s.addPendingUser("hello", 0);
		s.reset([userMessage("old"), assistant([{ type: "text", text: "reply" }])]);
		assert.deepEqual(users(s.transcript), [
			{ kind: "user", id: "h0", text: "old" },
			{ kind: "user", id: waiting, text: "hello", pending: true },
		]);
		apply({ type: "message_start", messageId: "u-9", message: userMessage("hello") });
		assert.deepEqual(
			users(s.transcript).map(item => [item.id, item.pending]),
			[
				["h0", undefined],
				[waiting, undefined],
			],
		);
	});
});

describe("SessionStore turn summaries", () => {
	/** Usage as OMP reports it; without `total`, as a provider that reports no cost would. */
	const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number, total?: number) =>
		({
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens: input + output + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(total === undefined ? {} : { total }) },
		}) as AssistantMessage["usage"];
	const userMessage = (text: string) => ({ role: "user", content: text, timestamp: 1 });

	function timed() {
		const clock = { now: 1_000 };
		const s = new SessionStore(undefined, () => clock.now);
		const changes: TranscriptItem[] = [];
		s.onDidChangeItem(item => changes.push(item));
		return { s, clock, changes, apply: (e: object) => s.applyEvent(e as SessionEvent) };
	}

	const summaries = (items: readonly TranscriptItem[]) => items.filter(item => item.kind === "turn_summary").map(item => ({ ...item }));

	it("appends the duration, summed usage and cost of a finished turn after its last item", () => {
		const { s, clock, changes, apply } = timed();
		s.update({ phase: "submitting" });
		apply({ type: "agent_start" });
		s.update({ phase: "running" });
		apply({ type: "message_end", messageId: "u-1", message: userMessage("fix it") });
		apply({
			type: "message_end",
			messageId: "a-1",
			message: assistant([{ type: "toolCall", id: "t1", name: "read", arguments: {} }], { stopReason: "toolUse", usage: tokens(100, 20, 1_000, 50, 0.01) }),
		});
		apply({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: {} });
		apply({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [] } });
		apply({ type: "message_end", messageId: "a-2", message: assistant([{ type: "text", text: "done" }], { usage: tokens(200, 30, 2_000, 0, 0.02) }) });
		apply({ type: "agent_end", messages: [] });
		clock.now = 73_000;
		s.update({ phase: "idle" });
		assert.deepEqual(
			s.transcript.map(item => item.kind),
			["user", "assistant", "tool", "assistant", "turn_summary"],
		);
		const [summary] = summaries(s.transcript);
		assert.deepEqual(summary, {
			kind: "turn_summary",
			id: summary.id,
			status: "completed",
			durationMs: 72_000,
			usage: { input: 300, output: 50, cacheRead: 3_000, cacheWrite: 50, costUsd: 0.03 },
		});
		assert.equal(changes.at(-1)?.kind, "turn_summary");
		assert.equal(new Set(s.transcript.map(item => item.id)).size, s.transcript.length, "ids are unique");
	});

	it("reports the start and the output tokens of the turn in progress", () => {
		const { s, clock, apply } = timed();
		s.update({ phase: "submitting" });
		assert.deepEqual(s.session.turn, { startedAt: 1_000, outputTokens: 0 });
		clock.now = 5_000;
		s.update({ phase: "running" });
		apply({
			type: "message_end",
			messageId: "a-1",
			message: assistant([{ type: "text", text: "x" }], { stopReason: "toolUse", usage: tokens(1, 1_200, 0, 0) }),
		});
		assert.deepEqual(s.session.turn, { startedAt: 1_000, outputTokens: 1_200 });
		s.update({ phase: "idle" });
		assert.equal("turn" in s.session, false);
	});

	it("marks a turn stopped when it was aborted and failed when OMP reported an error", () => {
		const { s, apply } = timed();
		s.update({ phase: "running" });
		apply({ type: "agent_start" });
		s.update({ phase: "aborting" });
		apply({ type: "message_end", messageId: "a-1", message: assistant([], { stopReason: "aborted" }) });
		s.update({ phase: "idle" });
		s.update({ phase: "submitting" });
		apply({ type: "agent_start" });
		apply({ type: "message_end", messageId: "a-2", message: assistant([], { stopReason: "error", errorMessage: "overloaded" }) });
		s.noteTurnOutcome("error");
		s.update({ phase: "idle" });
		assert.deepEqual(
			summaries(s.transcript).map(item => item.kind === "turn_summary" && item.status),
			["aborted", "error"],
		);
	});

	it("takes OMP's outcome over a failed reply that a retry recovered from", () => {
		const { s, apply } = timed();
		s.update({ phase: "submitting" });
		apply({ type: "agent_start" });
		apply({ type: "message_end", messageId: "a-1", message: assistant([], { stopReason: "error", errorMessage: "overloaded" }) });
		apply({ type: "message_end", messageId: "a-2", message: assistant([{ type: "text", text: "ok" }]) });
		s.noteTurnOutcome("completed");
		s.update({ phase: "idle" });
		assert.deepEqual(
			summaries(s.transcript).map(item => item.kind === "turn_summary" && item.status),
			["completed"],
		);
	});

	it("adds no summary for a prompt the agent never worked on", () => {
		const { s } = timed();
		s.update({ phase: "submitting" });
		s.addCommandOutput("No rules.");
		s.update({ phase: "idle" });
		assert.deepEqual(
			s.transcript.map(item => item.kind),
			["command_output"],
		);
		assert.equal("turn" in s.session, false);
	});

	it("ends the turn at the prompt result and summarizes background work that wakes the agent as its own turn", () => {
		const { s, clock, apply } = timed();
		s.update({ phase: "submitting" });
		apply({ type: "agent_start" });
		s.update({ phase: "running" });
		apply({ type: "message_end", messageId: "a-1", message: assistant([{ type: "text", text: "started a job" }]) });
		clock.now = 4_000;
		s.update({ phase: "yielded" });
		clock.now = 10_000;
		apply({ type: "agent_start" });
		assert.deepEqual(s.session.turn, { startedAt: 10_000, outputTokens: 0 });
		s.update({ phase: "running" });
		apply({ type: "message_end", messageId: "a-2", message: assistant([{ type: "text", text: "job done" }]) });
		clock.now = 12_500;
		s.update({ phase: "yielded" });
		s.update({ phase: "idle" });
		assert.deepEqual(
			s.transcript.map(item => item.kind),
			["assistant", "turn_summary", "assistant", "turn_summary"],
		);
		assert.deepEqual(
			summaries(s.transcript).map(item => item.kind === "turn_summary" && item.durationMs),
			[3_000, 2_500],
		);
	});

	it("leaves out a cost no reply reported", () => {
		const { s, apply } = timed();
		s.update({ phase: "running" });
		apply({ type: "agent_start" });
		apply({ type: "message_end", messageId: "a-1", message: assistant([], { usage: tokens(5, 6, 0, 0) }) });
		s.update({ phase: "idle" });
		assert.deepEqual(
			summaries(s.transcript).map(item => item.kind === "turn_summary" && item.usage),
			[{ input: 5, output: 6, cacheRead: 0, cacheWrite: 0 }],
		);
	});
});

describe("historyToItems turn summaries", () => {
	const userAt = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
	const toolResultAt = (toolCallId: string, timestamp: number) => ({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [],
		isError: false,
		timestamp,
	});
	const kinds = (items: readonly TranscriptItem[]) => items.map(item => item.kind);
	const summaries = (items: readonly TranscriptItem[]) => items.flatMap(item => (item.kind === "turn_summary" ? [{ ...item }] : []));

	it("summarizes each stored turn after its last item, timed by its messages", () => {
		const items = historyToItems([
			userAt("fix it", 10_000),
			assistant([{ type: "toolCall", id: "t1", name: "read", arguments: {} }], { stopReason: "toolUse", timestamp: 11_000 }),
			toolResultAt("t1", 15_000),
			assistant([{ type: "text", text: "fixed" }], { timestamp: 82_000 }),
			{ role: "bashExecution", command: "ls", output: "a", cancelled: false, truncated: false, timestamp: 90_000 },
			userAt("again", 100_000),
			assistant([{ type: "text", text: "no" }], { stopReason: "aborted", timestamp: 103_000 }),
		]);
		assert.deepEqual(kinds(items), ["user", "assistant", "tool", "assistant", "turn_summary", "command_output", "user", "assistant", "turn_summary"]);
		const [first, second] = summaries(items);
		assert.deepEqual(first, {
			kind: "turn_summary",
			id: first.id,
			status: "completed",
			durationMs: 72_000,
			usage: { input: 20, output: 10, cacheRead: 2, cacheWrite: 4, costUsd: 0.02 },
		});
		assert.equal(second.status, "aborted");
		assert.equal(second.durationMs, 3_000);
		assert.equal(new Set(items.map(item => item.id)).size, items.length, "ids are unique");
	});

	it("keeps a message steering a run that was still calling tools in the same turn", () => {
		const items = historyToItems([
			userAt("start", 1_000),
			assistant([{ type: "toolCall", id: "t1", name: "read", arguments: {} }], { stopReason: "toolUse", timestamp: 2_000 }),
			toolResultAt("t1", 3_000),
			userAt("also check b", 3_500),
			assistant([{ type: "text", text: "both done" }], { stopReason: "error", errorMessage: "boom", timestamp: 6_000 }),
		]);
		assert.deepEqual(kinds(items), ["user", "assistant", "tool", "user", "assistant", "turn_summary"]);
		assert.deepEqual(
			summaries(items).map(item => [item.status, item.durationMs]),
			[["error", 5_000]],
		);
	});

	it("adds no summary to a run the history ends in the middle of, nor to a turn without a reply", () => {
		const items = historyToItems([
			userAt("/rules", 1_000),
			userAt("go", 2_000),
			assistant([{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], { stopReason: "toolUse", timestamp: 3_000 }),
		]);
		assert.deepEqual(kinds(items), ["user", "user", "assistant", "tool"]);
	});

	it("omits the duration when the messages carry no timestamps", () => {
		const items = historyToItems([
			{ role: "user", content: "hi" } as AgentMessage,
			assistant([{ type: "text", text: "hello" }], { timestamp: undefined as unknown as number }),
		]);
		const [summary] = summaries(items);
		assert.equal(summary.status, "completed");
		assert.equal("durationMs" in summary, false);
	});
});
