import * as assert from "node:assert/strict";
import type { AgentView } from "../../src/omp/api";
import { AgentRegistry } from "../../src/omp/agents";
import type { SubagentFrame, SubagentSnapshot } from "../../src/omp/protocol";

const lifecycle = (id: string, status: "started" | "completed" | "failed" | "aborted", extra = {}): SubagentFrame => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "task", agentSource: "bundled", status, index: 0, description: `do ${id}`, sessionFile: `/s/${id}.jsonl`, ...extra },
});

describe("AgentRegistry", () => {
	it("synthesizes the main agent from session phase, model and activity", () => {
		const registry = new AgentRegistry();
		const changes: Array<readonly AgentView[]> = [];
		registry.onDidChange(a => changes.push(a));
		registry.setMain({ phase: "idle", model: "anthropic/claude" });
		assert.deepEqual(registry.agents, [{ id: "main", name: "main", status: "completed", model: "anthropic/claude" }]);
		registry.setMain({ phase: "running", model: "anthropic/claude", activity: "read" });
		assert.equal(registry.agents[0].status, "running");
		assert.equal(registry.agents[0].activity, "read");
		const before = changes.length;
		registry.setMain({ phase: "running", model: "anthropic/claude", activity: "read" });
		assert.equal(changes.length, before, "unchanged main does not fire");
	});

	it("tracks subagents through lifecycle and progress frames", () => {
		const registry = new AgentRegistry();
		registry.setMain({ phase: "running" });
		registry.applyFrame(lifecycle("Anna", "started"));
		let anna = registry.agents.find(a => a.id === "Anna")!;
		assert.equal(anna.status, "running");
		assert.equal(anna.parentId, "main");
		assert.equal(anna.name, "task");
		assert.equal(anna.description, "do Anna");
		assert.equal(anna.sessionFile, "/s/Anna.jsonl");
		assert.ok(anna.startedAt);

		registry.applyFrame({
			type: "subagent_progress",
			payload: {
				index: 0,
				agent: "task",
				agentSource: "bundled",
				task: "t",
				progress: { id: "Anna", status: "running", currentTool: "grep", toolCount: 4, tokens: 1200, cost: 0.02, resolvedModel: "openai/gpt" },
			},
		});
		anna = registry.agents.find(a => a.id === "Anna")!;
		assert.equal(anna.activity, "grep");
		assert.equal(anna.toolCount, 4);
		assert.equal(anna.tokens, 1200);
		assert.equal(anna.costUsd, 0.02);
		assert.equal(anna.model, "openai/gpt");

		registry.applyFrame(lifecycle("Anna", "failed"));
		anna = registry.agents.find(a => a.id === "Anna")!;
		assert.equal(anna.status, "failed");
		assert.ok(anna.endedAt);
		assert.equal(anna.activity, undefined);
	});

	it("derives nested parents from dotted ids", () => {
		const registry = new AgentRegistry();
		registry.applyFrame(lifecycle("Anna", "started"));
		registry.applyFrame(lifecycle("Anna.Bob", "started"));
		assert.equal(registry.agents.find(a => a.id === "Anna.Bob")!.parentId, "Anna");
	});

	it("ignores progress for unknown subagents and applies snapshots", () => {
		const registry = new AgentRegistry();
		registry.applyFrame({
			type: "subagent_progress",
			payload: { index: 0, agent: "task", agentSource: "bundled", task: "t", progress: { id: "Ghost", status: "running" } },
		});
		assert.equal(registry.agents.length, 1, "only main");
		const snapshot: SubagentSnapshot = {
			id: "Cleo",
			index: 1,
			agent: "scout",
			agentSource: "bundled",
			status: "running",
			lastUpdate: 10_000,
			task: "look",
			progress: { lastIntent: "Scanning", durationMs: 4000, retryFailure: { attempt: 2, errorMessage: "429" } },
		};
		registry.applySnapshot([snapshot]);
		const cleo = registry.agents.find(a => a.id === "Cleo")!;
		assert.equal(cleo.name, "scout");
		assert.equal(cleo.description, "look");
		assert.equal(cleo.activity, "Scanning");
		assert.equal(cleo.startedAt, 6000);
		assert.equal(cleo.error, "429");
	});

	it("drops subagents on clear but keeps main", () => {
		const registry = new AgentRegistry();
		registry.applyFrame(lifecycle("Anna", "started"));
		registry.clearSubagents();
		assert.deepEqual(registry.agents.map(a => a.id), ["main"]);
	});
});
