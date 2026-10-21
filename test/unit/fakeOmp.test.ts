import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OmpRpcClient } from "../../src/omp/client";
import { OmpProcess } from "../../src/omp/process";
import type { AgentMessage, AssistantMessage, PromptResultFrame, SessionEvent, ToolResultMessage } from "../../src/omp/protocol";
import { FAKE_OMP, memoryLogger, waitFor } from "./helpers";

/** The fake OMP the extension-host tests drive, checked over a real pipe against what real OMP sends. */
describe("fake OMP fixture", function () {
	this.timeout(15000);
	let sessionDir: string;
	let proc: OmpProcess;
	let client: OmpRpcClient;
	let events: SessionEvent[];
	let results: PromptResultFrame[];
	let stdout: string;
	const logger = memoryLogger();

	beforeEach(async () => {
		sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-omp-it "));
		proc = new OmpProcess({ executable: FAKE_OMP, args: [], cwd: sessionDir, env: { ...process.env, FAKE_OMP_SESSION_DIR: sessionDir }, logger });
		client = new OmpRpcClient(proc, { logger });
		events = [];
		results = [];
		stdout = "";
		proc.onData(chunk => {
			stdout += Buffer.from(chunk).toString("utf8");
		});
		client.onSessionEvent(event => events.push(event));
		client.onPromptResult(result => results.push(result));
		await client.start();
	});
	afterEach(async () => {
		await proc.shutdown(500);
		client.dispose();
		fs.rmSync(sessionDir, { recursive: true, force: true });
	});

	async function prompt(message: string): Promise<PromptResultFrame> {
		const id = client.nextId();
		await client.request("prompt", { message }, { id });
		await waitFor(() => results.some(result => result.id === id), 10_000, `prompt_result ${id}`);
		return results.find(result => result.id === id)!;
	}

	/** `AgentMessage` keeps an open catch-all role, so a role check does not narrow it; the casts follow the checks. */
	function assistantToolCallIds(messages: readonly AgentMessage[]): string[] {
		const ids: string[] = [];
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			for (const part of assistant.content) if (part.type === "toolCall" && "id" in part) ids.push(String(part.id));
		}
		return ids;
	}

	function toolResultIds(messages: readonly AgentMessage[]): string[] {
		const ids: string[] = [];
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			const result = message as ToolResultMessage;
			ids.push(result.toolCallId);
		}
		return ids;
	}

	it("records each tool call under one id shared by the assistant call, its execution events and its stored result", async () => {
		const dir = path.join(sessionDir, "my dir");
		fs.mkdirSync(dir);
		const file = path.join(dir, "sample file.txt");
		fs.writeFileSync(file, "alpha\n");
		assert.equal((await prompt(`tool ${file}`)).status, "completed");
		assert.match(fs.readFileSync(file, "utf8"), /edited by fake-omp/);

		const streamed = events.flatMap(event => (event.type === "message_end" ? [event.message] : []));
		const called = assistantToolCallIds(streamed);
		const started = events.flatMap(event => (event.type === "tool_execution_start" ? [event.toolCallId] : []));
		const ended = events.flatMap(event => (event.type === "tool_execution_end" ? [event.toolCallId] : []));
		assert.equal(called.length, 2);
		assert.deepEqual(started, called);
		assert.deepEqual(ended, called);

		const { messages } = await client.request("get_messages");
		const stored = toolResultIds(messages);
		assert.deepEqual(stored, assistantToolCallIds(messages));
		assert.deepEqual(stored, called);
	});

	it("ends a scenario that throws with an error result and keeps serving", async () => {
		const result = await prompt(`racyedit ${path.join(sessionDir, "missing dir", "gone.txt")}`);
		assert.equal(result.status, "error");
		assert.match(result.error?.message ?? "", /ENOENT/);
		assert.equal(proc.exited, false);
		assert.equal((await prompt("hello again")).status, "completed");
	});

	it("sends a frame above the frame limit as rpc_chunk frames the client reassembles", async () => {
		assert.equal(client.protocolVersion, 2);
		await prompt("bigframe");
		const big = events.find(event => event.type === "message_end" && event.message.role === "assistant");
		assert.ok(big?.type === "message_end");
		const reply = big.message as AssistantMessage;
		const [part] = reply.content;
		assert.ok(part.type === "text" && "text" in part && String(part.text).length === "big ".length * 400_000);
		assert.ok(stdout.includes('"type":"rpc_chunk"'), "the frame crossed the pipe in chunks");
		assert.doesNotMatch(logger.text("warn"), /rejected|exceeds/);
	});
});
