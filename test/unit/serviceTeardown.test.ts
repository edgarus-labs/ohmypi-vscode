import * as assert from "node:assert/strict";
import * as os from "node:os";
import type { AgentView, SessionView, TranscriptItem } from "../../src/omp/api";
import { OmpService } from "../../src/omp/service";
import { memoryLogger, tick, waitFor } from "./helpers";
import { MemoryOmp, NO_REPLY } from "./memoryOmp";

const snapshot = (id: string, status: string) => ({ id, index: 0, agent: "task", agentSource: "bundled", status, lastUpdate: 1 });

describe("OmpService when its process goes away", () => {
	let services: OmpService[] = [];

	afterEach(async () => {
		for (const service of services) await service.stop().catch(() => undefined);
		services = [];
	});

	function create(omp: MemoryOmp | (() => MemoryOmp), options: { autoRestart?: boolean; restartDelaysMs?: number[] } = {}) {
		const service = new OmpService(
			{ executable: "memory-omp", extraArgs: [], cwd: os.tmpdir(), logger: memoryLogger(), autoRestart: options.autoRestart ?? false },
			{ spawn: typeof omp === "function" ? omp : () => omp, shutdownGraceMs: 50, restartDelaysMs: options.restartDelaysMs },
		);
		services.push(service);
		return service;
	}

	it("fails the subagents that were still running when OMP exits", async () => {
		const omp = new MemoryOmp({ get_subagents: () => ({ subagents: [snapshot("A", "running"), snapshot("B", "completed")] }) });
		const service = create(omp);
		await service.start();
		omp.close(3);
		await waitFor(() => service.connection.state === "failed", 1000, "failed");
		const byId = (id: string) => service.agents.find(agent => agent.id === id);
		assert.equal(byId("A")?.status, "failed");
		assert.match(byId("A")?.error ?? "", /exited \(code 3\)/);
		assert.equal(byId("B")?.status, "completed");
	});

	it("closes the reply and the tool that were in progress when OMP exits", async () => {
		const omp = new MemoryOmp({
			prompt: (frame, transport) => {
				transport.reply(frame, { agentInvoked: true });
				transport.emit({ type: "agent_start" });
				transport.emit({ type: "message_start", messageId: "a-1", message: { role: "assistant", content: [] } });
				transport.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
				return NO_REPLY;
			},
		});
		const service = create(omp);
		await service.start();
		const outcome = service.prompt("go");
		await waitFor(() => service.transcript.some(item => item.id === "t1"), 1000, "tool started");
		omp.close(3);
		await outcome;
		const reply = service.transcript.find(item => item.id === "a-1");
		const tool = service.transcript.find(item => item.id === "t1");
		assert.equal(reply?.kind === "assistant" && reply.streaming, false);
		assert.equal(tool?.kind === "tool" && tool.status, "error");
		assert.match((tool?.kind === "tool" && tool.result?.text) || "", /^Interrupted: OMP process .*exited \(code 3\)/);
	});

	it("shows the current tool of a running subagent's transcript as running", async () => {
		const call = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "grep", arguments: {} }], stopReason: "toolUse", timestamp: 1 };
		const omp = new MemoryOmp({
			get_subagents: () => ({ subagents: [snapshot("A", "running"), snapshot("B", "aborted")] }),
			get_subagent_messages: () => ({ messages: [call] }),
		});
		const service = create(omp);
		await service.start();
		const running = (await service.getAgentTranscript("A")).find(item => item.kind === "tool");
		const aborted = (await service.getAgentTranscript("B")).find(item => item.kind === "tool");
		assert.equal(running?.kind === "tool" && running.status, "running");
		assert.equal(aborted?.kind === "tool" && aborted.status, "unresolved");
	});

	it("restart while an automatic restart is pending launches one process and ends ready", async () => {
		const omps: MemoryOmp[] = [];
		const service = create(
			() => {
				const omp = new MemoryOmp();
				omps.push(omp);
				return omp;
			},
			{ autoRestart: true, restartDelaysMs: [200] },
		);
		await service.start();
		omps[0].close(3);
		await waitFor(() => service.connection.state === "restarting", 1000, "restarting");
		await service.restart();
		await tick(300);
		assert.equal(service.connection.state, "ready");
		assert.equal(omps.length, 2);
		assert.equal(service.connection.pid, omps[1].pid);
	});

	it("notifies no listener once disposed", async () => {
		const omp = new MemoryOmp({ get_subagents: () => ({ subagents: [snapshot("A", "running")] }) });
		const service = create(omp);
		await service.start();
		const sessions: SessionView[] = [];
		const agents: Array<readonly AgentView[]> = [];
		const items: TranscriptItem[] = [];
		service.onDidChangeSession(session => sessions.push(session));
		service.onDidChangeAgents(list => agents.push(list));
		service.onDidChangeTranscriptItem(item => items.push(item));
		service.dispose();
		await waitFor(() => omp.closed, 1000, "process stopped");
		await tick(20);
		assert.deepEqual([sessions, agents, items], [[], [], []]);
	});
});
