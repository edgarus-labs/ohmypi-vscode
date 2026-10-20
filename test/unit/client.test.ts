import * as assert from "node:assert/strict";
import { describeClose, OmpRequestError, OmpRpcClient } from "../../src/omp/client";
import type { SessionEvent, UnknownFrame } from "../../src/omp/protocol";
import { isRecord } from "../../src/shared/guards";
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

	it("rejects only the request whose write the transport reports as failed afterwards", async () => {
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		transport.failWritesLater = new Error("write EPIPE");
		const failed = client.request("get_state", undefined, { timeoutMs: 0 }).catch(e => e);
		transport.failWritesLater = undefined;
		const other = client.request("get_state", undefined, { timeoutMs: 0 });
		const error = await failed;
		assert.ok(error instanceof OmpRequestError);
		assert.equal(error.code, "write_failed");
		assert.match(error.message, /get_state.*write EPIPE/);
		transport.reply(transport.sent("get_state")[1], { ok: true });
		assert.deepEqual(await other, { ok: true });
	});

	it("logs a UI response the transport fails to deliver afterwards", async () => {
		const transport = new MemoryTransport();
		const logger = memoryLogger();
		const client = new OmpRpcClient(transport, { logger });
		transport.failWritesLater = new Error("write EPIPE");
		client.sendUiResponse({ type: "extension_ui_response", id: "u1", confirmed: true });
		await tick();
		assert.match(logger.text("warn"), /extension_ui_response.*write EPIPE/);
	});

	it("sends an outbound frame above the negotiated frame limit as one line and warns about it", async () => {
		const transport = negotiating();
		const logger = memoryLogger();
		const client = new OmpRpcClient(transport, { logger });
		transport.emit({ ...READY_V2, maxFrameBytes: 256 });
		await client.start();
		void client.request("prompt", { message: "short" }, { timeoutMs: 0 }).catch(() => undefined);
		assert.equal(logger.text("warn"), "");
		void client.request("prompt", { message: "x".repeat(300) }, { timeoutMs: 0 }).catch(() => undefined);
		assert.equal(transport.sent("prompt").length, 2);
		assert.equal(transport.sent("rpc_chunk").length, 0);
		assert.match(logger.text("warn"), /prompt frame of \d+ bytes exceeds the 256-byte frame limit OMP advertised/);
	});

	it("drops inbound lines above the negotiated frame limit", async () => {
		const transport = negotiating();
		const logger = memoryLogger();
		const client = new OmpRpcClient(transport, { logger });
		transport.emit({ ...READY_V2, maxFrameBytes: 256 });
		await client.start();
		const output: string[] = [];
		client.onCommandOutput(e => output.push(e.text));
		transport.emit({ type: "command_output", text: "x".repeat(300) });
		transport.emit({ type: "command_output", text: "ok" });
		assert.deepEqual(output, ["ok"]);
		assert.match(logger.text("warn"), /exceeds 256 bytes/);
	});

	it("accepts inbound lines up to a negotiated frame limit above the default", async () => {
		const transport = negotiating();
		const logger = memoryLogger();
		const client = new OmpRpcClient(transport, { logger });
		transport.emit({ ...READY_V2, maxFrameBytes: 12 * 1024 * 1024 });
		await client.start();
		const output: string[] = [];
		client.onCommandOutput(e => output.push(e.text));
		const text = "x".repeat(9 * 1024 * 1024);
		transport.emit({ type: "command_output", text });
		assert.equal(output[0]?.length, text.length);
		assert.equal(logger.text("warn"), "");
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

	it("dispatches available_commands_update frames to onAvailableCommands", async () => {
		const logger = memoryLogger();
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger });
		const seen: string[][] = [];
		const unknown: UnknownFrame[] = [];
		client.onAvailableCommands(frame => seen.push(frame.commands.map(c => c.name)));
		client.onUnknownFrame(f => unknown.push(f));
		transport.emit({ type: "available_commands_update", commands: [{ name: "model", source: "builtin" }, { name: "skill:x", source: "skill" }] });
		assert.deepEqual(seen, [["model", "skill:x"]]);
		assert.deepEqual(unknown, []);
		assert.doesNotMatch(logger.text("debug"), /available_commands_update ignored/);
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
		transport.emit({ ...READY_V2, maxFrameBytes: 256 });
		await client.start();
		const output: string[] = [];
		client.onCommandOutput(e => output.push(e.text));
		const bytes = Buffer.from(JSON.stringify({ type: "command_output", text: "żółw ".repeat(60) }));
		const size = 96;
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
		assert.deepEqual(output, ["żółw ".repeat(60)]);
	});

	it("traces abbreviated frames and redacts secret UI responses", async () => {
		const logger = memoryLogger({ trace: true });
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger });
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

	it("follows the logger's trace switch for every frame", async () => {
		const logger = memoryLogger();
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger });
		transport.emit({ type: "agent_start" });
		logger.traceEnabled = true;
		transport.emit({ type: "agent_end" });
		client.sendUiResponse({ type: "extension_ui_response", id: "u", confirmed: true });
		logger.traceEnabled = false;
		transport.emit({ type: "turn_start" });
		await tick();
		const trace = logger.text("trace");
		assert.ok(!trace.includes("agent_start"), "frames before tracing was switched on are not traced");
		assert.ok(trace.includes("agent_end"), "inbound frames are traced once tracing is on");
		assert.ok(trace.includes("extension_ui_response"), "outbound frames are traced once tracing is on");
		assert.ok(!trace.includes("turn_start"), "frames after tracing was switched off are not traced");
	});
});

describe("describeClose", () => {
	it("names a spawn or pipe failure, a signal, or the exit code", () => {
		assert.equal(describeClose({ code: null, signal: null, error: new Error("spawn omp ENOENT") }), "OMP process failed: spawn omp ENOENT");
		assert.equal(describeClose({ code: null, signal: "SIGTERM" }), "OMP process exited (signal SIGTERM)");
		assert.equal(describeClose({ code: 3, signal: null }), "OMP process exited (code 3)");
	});

	it("names the process id and appends OMP's last stderr lines", () => {
		assert.equal(
			describeClose({ code: 1, signal: null, pid: 42, stderr: "boom\n'node' is not recognized" }),
			"OMP process 42 exited (code 1)\nOMP stderr (last lines):\nboom\n'node' is not recognized",
		);
		assert.equal(describeClose({ code: null, signal: "SIGKILL", pid: 7 }), "OMP process 7 exited (signal SIGKILL)");
	});

	it("keeps stderr out of the errors of requests the close rejected", async () => {
		const transport = new MemoryTransport();
		const client = new OmpRpcClient(transport, { logger: memoryLogger() });
		const pending = client.request("get_state").catch(e => e);
		transport.close(1, null, { pid: 42, stderr: "boom" });
		assert.equal((await pending).message, "OMP process 42 exited (code 1); get_state did not complete");
		assert.equal((await client.request("get_state").catch(e => e)).message, "OMP process 42 exited (code 1); cannot send get_state");
	});
});
