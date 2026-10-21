import * as assert from "node:assert/strict";
import * as os from "node:os";
import type { HostToolDefinition, HostTools, HostToolSignal } from "../../src/omp/api";
import { OmpRpcClient } from "../../src/omp/client";
import { MAX_HOST_TOOL_TEXT, truncateToolText } from "../../src/omp/hostTools";
import { OmpService } from "../../src/omp/service";
import { MemoryTransport, memoryLogger, READY_V2, tick, waitFor } from "./helpers";
import { MemoryOmp, NO_REPLY } from "./memoryOmp";

const DEFINITION: HostToolDefinition = {
	name: "vscode_echo",
	description: "Echoes its text.",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: [], additionalProperties: false },
};

interface Invocation {
	name: string;
	args: Record<string, unknown>;
	signal: HostToolSignal;
}

/** Host tools whose `invoke` runs `behave` and records every call. */
function fakeTools(behave: (call: Invocation) => Promise<string>, definitions: HostToolDefinition[] = [DEFINITION]) {
	const calls: Invocation[] = [];
	const tools: HostTools = {
		definitions,
		invoke: (name, args, signal) => {
			const call = { name, args, signal };
			calls.push(call);
			return behave(call);
		},
	};
	return { tools, calls };
}

const never = () => new Promise<string>(() => undefined);

describe("OmpService host tools", () => {
	let services: OmpService[] = [];

	afterEach(async () => {
		for (const service of services) await service.stop().catch(() => undefined);
		services = [];
	});

	function create(omp: MemoryOmp | (() => MemoryOmp), hostTools: HostTools | undefined) {
		const logger = memoryLogger();
		const service = new OmpService(
			{ executable: "memory-omp", extraArgs: [], cwd: os.tmpdir(), logger, autoRestart: false, hostTools },
			{ spawn: typeof omp === "function" ? omp : () => omp, shutdownGraceMs: 50 },
		);
		services.push(service);
		return { service, logger };
	}

	const acceptingTools = () => new MemoryOmp({ set_host_tools: frame => ({ tools: frame.tools }) });

	const resultFor = async (omp: MemoryOmp, id: string) => {
		await waitFor(() => omp.sent("host_tool_result").some(frame => frame.id === id), 2000, `result ${id}`);
		return omp.sent("host_tool_result").find(frame => frame.id === id)!;
	};

	it("registers its tools during configuration of every OMP process it starts", async () => {
		const omps: MemoryOmp[] = [];
		const { service } = create(() => {
			const omp = acceptingTools();
			omps.push(omp);
			return omp;
		}, fakeTools(never).tools);
		await service.start();
		await service.restart();
		assert.equal(omps.length, 2);
		for (const omp of omps) {
			const types = omp.written.map(frame => frame.type);
			assert.deepEqual(
				omp.sent("set_host_tools").map(frame => frame.tools),
				[[DEFINITION]],
			);
			assert.ok(types.indexOf("set_subagent_subscription") < types.indexOf("set_host_tools"));
			assert.ok(types.indexOf("set_host_tools") < types.indexOf("set_ask_dialog"));
		}
	});

	it("sends no registration when it has no tools", async () => {
		const omp = acceptingTools();
		const { service } = create(omp, fakeTools(never, []).tools);
		await service.start();
		assert.deepEqual(omp.sent("set_host_tools"), []);
	});

	it("warns and finishes starting when OMP rejects the registration", async () => {
		const omp = new MemoryOmp({
			set_host_tools: (frame, transport) => {
				transport.emit({ type: "response", id: frame.id, command: "set_host_tools", success: false, error: "no host tools", code: "unsupported" });
				return NO_REPLY;
			},
		});
		const { service, logger } = create(omp, fakeTools(never).tools);
		await service.start();
		assert.equal(service.connection.state, "ready");
		assert.match(logger.text("warn"), /OMP did not accept the VS Code tools \(unsupported\): .*no host tools/);
	});

	it("answers a call with the text its tool returns, passing empty arguments when OMP sends none", async () => {
		const omp = acceptingTools();
		const { tools, calls } = fakeTools(async call => `echo ${JSON.stringify(call.args)}`);
		const { service } = create(omp, tools);
		await service.start();
		omp.emit({ type: "host_tool_call", id: "h1", toolCallId: "t1", toolName: "vscode_echo", arguments: { text: "hi" } });
		omp.emit({ type: "host_tool_call", id: "h2", toolCallId: "t2", toolName: "vscode_echo" });
		assert.deepEqual(await resultFor(omp, "h1"), {
			type: "host_tool_result",
			id: "h1",
			isError: false,
			result: { content: [{ type: "text", text: 'echo {"text":"hi"}' }], isError: false },
		});
		assert.deepEqual((await resultFor(omp, "h2")).result, { content: [{ type: "text", text: "echo {}" }], isError: false });
		assert.deepEqual(
			calls.map(call => call.name),
			["vscode_echo", "vscode_echo"],
		);
	});

	it("answers a call whose tool throws as a tool error carrying the message", async () => {
		const omp = acceptingTools();
		const { service, logger } = create(omp, fakeTools(() => Promise.reject(new Error("'path' is required"))).tools);
		await service.start();
		omp.emit({ type: "host_tool_call", id: "h3", toolCallId: "t3", toolName: "vscode_echo", arguments: {} });
		assert.deepEqual(await resultFor(omp, "h3"), {
			type: "host_tool_result",
			id: "h3",
			isError: true,
			result: { content: [{ type: "text", text: "'path' is required" }], isError: true },
		});
		assert.match(logger.text("warn"), /Host tool vscode_echo failed: 'path' is required/);
	});

	it("aborts a call OMP cancels and answers that it was cancelled", async () => {
		const omp = acceptingTools();
		const { tools, calls } = fakeTools(never);
		const { service } = create(omp, tools);
		await service.start();
		omp.emit({ type: "host_tool_call", id: "h4", toolCallId: "t4", toolName: "vscode_echo", arguments: {} });
		await waitFor(() => calls.length === 1, 1000, "call");
		omp.emit({ type: "host_tool_cancel", targetId: "h4" });
		const result = await resultFor(omp, "h4");
		assert.equal(calls[0].signal.aborted, true);
		assert.deepEqual(result.result, { content: [{ type: "text", text: "vscode_echo was cancelled" }], isError: true });
		assert.equal(result.isError, true);
	});

	it("aborts every call in flight when its process goes away, without answering the dead process", async () => {
		const omp = acceptingTools();
		const { tools, calls } = fakeTools(never);
		const { service } = create(omp, tools);
		await service.start();
		omp.emit({ type: "host_tool_call", id: "h5", toolCallId: "t5", toolName: "vscode_echo", arguments: {} });
		omp.emit({ type: "host_tool_call", id: "h6", toolCallId: "t6", toolName: "vscode_echo", arguments: {} });
		await waitFor(() => calls.length === 2, 1000, "calls");
		omp.close(3);
		await waitFor(() => service.connection.state === "failed", 1000, "failed");
		assert.deepEqual(
			calls.map(call => call.signal.aborted),
			[true, true],
		);
		await tick(10);
		assert.deepEqual(omp.sent("host_tool_result"), []);
	});

	it("aborts every call in flight when it stops OMP", async () => {
		const omp = acceptingTools();
		const { tools, calls } = fakeTools(never);
		const { service } = create(omp, tools);
		await service.start();
		omp.emit({ type: "host_tool_call", id: "h7", toolCallId: "t7", toolName: "vscode_echo", arguments: {} });
		await waitFor(() => calls.length === 1, 1000, "call");
		await service.stop();
		assert.equal(calls[0].signal.aborted, true);
	});

	it("refuses calls as before when it has no host tools", async () => {
		const omp = new MemoryOmp();
		const { service } = create(omp, undefined);
		await service.start();
		omp.emit({ type: "host_tool_call", id: "h8", toolCallId: "t8", toolName: "vscode_echo", arguments: {} });
		const result = await resultFor(omp, "h8");
		assert.equal(result.isError, true);
		assert.deepEqual(result.result, { content: [{ type: "text", text: "Host tool vscode_echo is not provided by this client." }] });
		assert.deepEqual(omp.sent("set_host_tools"), []);
	});
});

describe("OmpRpcClient host tool frames", () => {
	it("ignores a call without a request id", async () => {
		const transport = new MemoryTransport();
		const logger = memoryLogger();
		const client = new OmpRpcClient(transport, { logger });
		const calls: unknown[] = [];
		client.handleHostTools({ call: frame => calls.push(frame), cancel: () => undefined });
		transport.emit(READY_V2);
		transport.emit({ type: "host_tool_call", toolCallId: "t", toolName: "vscode_echo", arguments: {} });
		await tick();
		assert.deepEqual(calls, []);
		assert.deepEqual(transport.sent("host_tool_result"), []);
		assert.match(logger.text("warn"), /host_tool_call without an id/);
	});
});

describe("truncateToolText", () => {
	it("keeps short text unchanged", () => {
		assert.equal(truncateToolText("short"), "short");
	});

	it("keeps the head of long text, cut at a line break, followed by a marker within the limit", () => {
		const line = `${"x".repeat(99)}\n`;
		const text = line.repeat(1000);
		const truncated = truncateToolText(text, "; narrow the range");
		assert.ok(truncated.length <= MAX_HOST_TOOL_TEXT);
		const [head, marker] = truncated.split("\n… ");
		assert.ok(text.startsWith(head));
		assert.ok(head.endsWith("x"));
		assert.equal(head.length % line.length, line.length - 1);
		assert.equal(marker, `[truncated: ${text.length - head.length} more characters; narrow the range]`);
	});

	it("cuts mid-line when no line break is near", () => {
		const text = "y".repeat(MAX_HOST_TOOL_TEXT * 2);
		const truncated = truncateToolText(text);
		assert.ok(truncated.length <= MAX_HOST_TOOL_TEXT);
		assert.match(truncated, /^y+\n… \[truncated: \d+ more characters\]$/);
	});
});
