import * as assert from "node:assert/strict";
import { OmpRequestError, OmpRpcClient } from "../../src/omp/client";
import { isRecord, type SessionEvent, type UnknownFrame } from "../../src/omp/protocol";
import { MemoryTransport, memoryLogger, READY_V2, tick } from "./helpers";

function negotiating(extra?: (frame: Record<string, unknown>, t: MemoryTransport) => void) {
	return new MemoryTransport((frame, t) => {
		if (frame.type === "negotiate_protocol") t.reply(frame, { protocolVersion: 2 });
		else extra?.(frame, t);
	});
}

describe("OmpRpcClient", () => {
	it("waits for ready and negotiates protocol v2 when advertised", async () => {
		const transport = negotiating();
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		const started = client.start();
		transport.emit(READY_V2);
		await started;
		assert.equal(client.protocolVersion, 2);
		assert.deepEqual(transport.sent("negotiate_protocol").map(f => f.protocolVersion), [2]);
	});

	it("stays on v1 without negotiating when the server does not advertise v2", async () => {
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		transport.emit({ type: "ready" });
		await client.start();
		assert.equal(client.protocolVersion, 1);
		assert.equal(transport.sent("negotiate_protocol").length, 0);
	});

	it("rejects start when no ready frame arrives in time", async () => {
		const client = new OmpRpcClient(new MemoryTransport(), { logger: memoryLogger(), readyTimeoutMs: 20 });
		await assert.rejects(client.start(), /ready/);
	});

	it("rejects start when the process closes before ready", async () => {
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger: memoryLogger(), readyTimeoutMs: 5000 });
		const started = client.start();
		transport.close(1);
		await assert.rejects(started, /exited/);
	});

	it("correlates out-of-order responses by id", async () => {
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		transport.emit({ type: "ready" });
		await client.start();
		const state = client.request("get_state");
		const levels = client.request("get_available_thinking_levels");
		const [stateReq, levelsReq] = transport.written;
		assert.notEqual(stateReq.id, levelsReq.id);
		transport.reply(levelsReq, { levels: ["off", "high"] });
		transport.reply(stateReq, { sessionId: "s1" });
		assert.deepEqual(await levels, { levels: ["off", "high"] });
		assert.deepEqual(await state, { sessionId: "s1" });
	});

	it("rejects failed commands with OmpRequestError carrying the server code", async () => {
		const transport = new MemoryTransport((frame, t) =>
			t.emit({ type: "response", id: frame.id, command: frame.type, success: false, error: "busy", code: "session_busy" }),
		);
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		const error = await client.request("get_messages_page", {}).catch(e => e);
		assert.ok(error instanceof OmpRequestError);
		assert.equal(error.code, "session_busy");
		assert.equal(error.command, "get_messages_page");
		assert.match(error.message, /busy/);
	});

	it("times out requests and ignores late responses", async () => {
		const logger = memoryLogger();
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger });
		const error = await client.request("get_state", undefined, { timeoutMs: 10 }).catch(e => e);
		assert.ok(error instanceof OmpRequestError);
		assert.equal(error.code, "timeout");
		transport.reply(transport.written[0], { sessionId: "late" });
		assert.match(logger.text("debug"), /late|unknown/i);
	});

	it("rejects pending requests when the transport closes", async () => {
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		const pending = client.request("get_state").catch(e => e);
		transport.close(3);
		const error = await pending;
		assert.ok(error instanceof OmpRequestError);
		assert.equal(error.code, "closed");
		const after = await client.request("get_state").catch(e => e);
		assert.equal(after.code, "closed");
	});

	it("rejects with write_failed when the transport cannot write", async () => {
		const transport = new MemoryTransport();
		transport.failWrites = true;
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		const error = await client.request("get_state").catch(e => e);
		assert.equal(error.code, "write_failed");
	});

	it("dispatches typed events by frame category", async () => {
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		const seen: string[] = [];
		client.onSessionEvent((e: SessionEvent) => seen.push(`session:${e.type}`));
		client.onPromptResult(e => seen.push(`prompt_result:${e.id}`));
		client.onSessionSettled(() => seen.push("settled"));
		client.onUiRequest(e => seen.push(`ui:${e.method}`));
		client.onSubagentFrame(e => seen.push(`sub:${e.type}`));
		client.onCommandOutput(e => seen.push(`out:${e.text}`));
		client.onSessionInfoUpdate(e => seen.push(`info:${e.title}`));
		client.onConfigUpdate(() => seen.push("config"));
		transport.emit({ type: "agent_start" });
		transport.emit({ type: "goal_updated", goal: null });
		transport.emit({ type: "prompt_result", id: "p1", agentInvoked: true, status: "completed", sessionSettled: true });
		transport.emit({ type: "session_settled" });
		transport.emit({ type: "extension_ui_request", id: "u1", method: "confirm", title: "t", message: "m" });
		transport.emit({ type: "subagent_lifecycle", payload: { id: "A", status: "started" } });
		transport.emit({ type: "command_output", text: "hi" });
		transport.emit({ type: "session_info_update", sessionId: "s", title: "T" });
		transport.emit({ type: "config_update" });
		assert.deepEqual(seen, [
			"session:agent_start",
			"session:goal_updated",
			"prompt_result:p1",
			"settled",
			"ui:confirm",
			"sub:subagent_lifecycle",
			"out:hi",
			"info:T",
			"config",
		]);
	});

	it("tolerates unknown frames and malformed lines without throwing", async () => {
		const logger = memoryLogger();
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger });
		const unknown: UnknownFrame[] = [];
		client.onUnknownFrame(f => unknown.push(f));
		transport.emit({ type: "brand_new_frame", x: 1 });
		transport.emit("{oops\n");
		transport.emit("[1,2]\n");
		transport.emit({ noType: true });
		assert.deepEqual(unknown, [{ type: "brand_new_frame", x: 1 }]);
		assert.match(logger.text("debug"), /brand_new_frame/);
		assert.match(logger.text("warn"), /Malformed/);
	});

	it("answers host tool calls and host URI requests with errors", async () => {
		const transport = new MemoryTransport();
		new OmpRpcClient(transport, { logger: memoryLogger() });
		transport.emit({ type: "host_tool_call", id: "h1", toolCallId: "t", toolName: "x", arguments: {} });
		transport.emit({ type: "host_uri_request", id: "u1", operation: "read", url: "db://x" });
		const toolResult = transport.sent("host_tool_result")[0];
		assert.equal(toolResult.id, "h1");
		assert.equal(toolResult.isError, true);
		const result = toolResult.result;
		assert.ok(isRecord(result) && Array.isArray(result.content));
		const uriResult = transport.sent("host_uri_result")[0];
		assert.equal(uriResult.id, "u1");
		assert.equal(uriResult.isError, true);
		assert.equal(typeof uriResult.error, "string");
	});

	it("logs a warning for responses without an id", async () => {
		const logger = memoryLogger();
		const transport = new MemoryTransport();
		new OmpRpcClient(transport, { logger });
		transport.emit({ type: "response", command: "parse", success: false, error: "Unexpected token" });
		assert.match(logger.text("warn"), /Unexpected token/);
	});

	it("reassembles chunked frames after negotiating v2", async () => {
		const transport = negotiating();
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		transport.emit({ ...READY_V2, maxFrameBytes: 16 });
		await client.start();
		const output: string[] = [];
		client.onCommandOutput(e => output.push(e.text));
		const bytes = Buffer.from(JSON.stringify({ type: "command_output", text: "żółw ".repeat(10) }));
		const size = 16;
		const count = Math.ceil(bytes.length / size);
		for (let index = 0; index < count; index++) {
			transport.emit({
				type: "rpc_chunk",
				chunkId: "c1",
				index,
				count,
				byteLength: bytes.length,
				data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
			});
		}
		assert.deepEqual(output, ["żółw ".repeat(10)]);
	});

	it("traces abbreviated frames and redacts secret UI responses", async () => {
		const logger = memoryLogger();
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger, trace: true });
		transport.emit({ type: "command_output", text: "x".repeat(5000) });
		client.sendUiResponse({ type: "extension_ui_response", id: "u1", value: "hunter2" }, true);
		client.sendUiResponse({ type: "extension_ui_response", id: "u2", value: "visible" }, false);
		const trace = logger.text("trace");
		assert.ok(!trace.includes("x".repeat(1000)), "long strings are abbreviated");
		assert.ok(!trace.includes("hunter2"), "secret value is redacted");
		assert.ok(trace.includes("visible"));
		assert.equal(transport.sent("extension_ui_response")[0].value, "hunter2");
	});

	it("does not trace when tracing is disabled", async () => {
		const logger = memoryLogger();
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger });
		transport.emit({ type: "agent_start" });
		client.sendUiResponse({ type: "extension_ui_response", id: "u", confirmed: true });
		await tick();
		assert.equal(logger.text("trace"), "");
	});
});
