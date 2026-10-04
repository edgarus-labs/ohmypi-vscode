import * as assert from "node:assert/strict";
import type { AgentView } from "../../../src/omp/api";
import { agentRowDescription, agentRowLabel, agentsSummary, changeRowDescription, changesSummary, sortAgents } from "../../../src/ui/treeRows";

function agent(overrides: Partial<AgentView>): AgentView {
	return { id: "a", name: "task", status: "completed", ...overrides };
}

describe("agent and change summaries", () => {
	it("labels subagents by their OMP name and keeps main as is", () => {
		assert.equal(agentRowLabel(agent({ id: "main", name: "main" })), "main");
		assert.equal(agentRowLabel(agent({ id: "ReviewAuth", name: "scout" })), "ReviewAuth");
		assert.equal(agentRowLabel(agent({ id: "Planner.Tests", name: "task" })), "Tests");
	});

	it("describes an agent row as type · status · truncated activity", () => {
		assert.equal(agentRowDescription(agent({ id: "ReviewAuth", name: "scout", status: "running", activity: "read src/a.ts" })), "scout · running · read src/a.ts");
		assert.equal(agentRowDescription(agent({ id: "main", name: "main", status: "completed" })), "completed");
		const long = agentRowDescription(agent({ status: "running", activity: "x".repeat(100) }));
		assert.ok(long.length <= 50, long);
		assert.ok(long.endsWith("…"));
		assert.equal(agentRowDescription(agent({ status: "running", activity: "line one\nline two" })), "task · running · line one");
	});

	it("sorts running agents first and keeps order otherwise", () => {
		const sorted = sortAgents([
			agent({ id: "1", status: "completed" }),
			agent({ id: "2", status: "running" }),
			agent({ id: "3", status: "pending" }),
			agent({ id: "4", status: "failed" }),
			agent({ id: "5", status: "running" }),
		]);
		assert.deepEqual(
			sorted.map(a => a.id),
			["2", "5", "3", "1", "4"],
		);
	});

	it("summarizes running agents", () => {
		assert.equal(agentsSummary([]), "");
		assert.equal(agentsSummary([agent({ status: "completed" })]), "");
		assert.equal(agentsSummary([agent({ status: "running" }), agent({ status: "running" }), agent({})]), "2 running");
	});

	it("summarizes and describes changes", () => {
		assert.equal(changesSummary(0), "");
		assert.equal(changesSummary(1), "1 file");
		assert.equal(changesSummary(3), "3 files");
		assert.equal(changeRowDescription({ path: "/w/src/auth/A.cs", status: "M", added: 3, removed: 1 }, "/w"), "M · src/auth · +3 −1");
		assert.equal(changeRowDescription({ path: "/w/A.cs", status: "A", added: 4, removed: 0 }, "/w"), "A · +4 −0");
		assert.equal(changeRowDescription({ path: "/w/old.cs", status: "D", added: 0, removed: 9 }, "/w"), "D");
		assert.equal(changeRowDescription({ path: "/x/y/B.cs", status: "M", added: 1, removed: 1 }, undefined), "M · /x/y · +1 −1");
	});
});
