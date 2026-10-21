import * as assert from "node:assert/strict";
import type { AgentView, OmpServiceApi } from "../../src/omp/api";
import { AgentTreeProvider } from "../../src/ui/AgentTreeProvider";
import { EventEmitter, MarkdownString, stub, TreeItemCollapsibleState } from "./stubs/vscode";

function provider(agents: AgentView[]): AgentTreeProvider {
	const tree = new AgentTreeProvider();
	tree.setService({ agents, onDidChangeAgents: new EventEmitter<readonly AgentView[]>().event } as unknown as OmpServiceApi);
	return tree;
}

const ids = (agents: readonly AgentView[]) => agents.map(agent => agent.id);

describe("AgentTreeProvider nesting", () => {
	beforeEach(() => stub.reset());

	it("nests subagents under their declared parent and the others under main", () => {
		const tree = provider([
			{ id: "main", name: "main", status: "running" },
			{ id: "A", parentId: "main", name: "task", status: "completed" },
			{ id: "A.B", parentId: "A", name: "task", status: "completed" },
			{ id: "C", name: "task", status: "completed" },
			{ id: "D", parentId: "gone", name: "task", status: "completed" },
			{ id: "E", parentId: "E", name: "task", status: "completed" },
		]);
		assert.deepEqual(ids(tree.getChildren()), ["main"]);
		const main = tree.find("main") as AgentView;
		assert.deepEqual(ids(tree.getChildren(main)), ["A", "C", "D", "E"]);
		assert.deepEqual(ids(tree.getChildren(tree.find("A"))), ["A.B"]);
		assert.equal(tree.getParent(tree.find("A.B") as AgentView)?.id, "A");
		assert.equal(tree.getParent(main), undefined);
		const parentRow = tree.getTreeItem(tree.find("A") as AgentView);
		assert.equal(parentRow.collapsibleState, TreeItemCollapsibleState.Expanded);
		assert.equal(parentRow.id, "A/tree");
		const leafRow = tree.getTreeItem(tree.find("A.B") as AgentView);
		assert.equal(leafRow.collapsibleState, TreeItemCollapsibleState.None);
		assert.equal(leafRow.id, "A.B");
	});

	it("shows the agents of a parent cycle under main and keeps their other children nested", () => {
		const tree = provider([
			{ id: "main", name: "main", status: "running" },
			{ id: "A", parentId: "B", name: "task", status: "completed" },
			{ id: "B", parentId: "C", name: "task", status: "completed" },
			{ id: "C", parentId: "A", name: "task", status: "completed" },
			{ id: "D", parentId: "A", name: "task", status: "completed" },
		]);
		assert.deepEqual(ids(tree.getChildren(tree.find("main"))), ["A", "B", "C"]);
		assert.deepEqual(ids(tree.getChildren(tree.find("A"))), ["D"]);
	});

	it("puts agents at the root when there is no main agent", () => {
		const tree = provider([
			{ id: "A", parentId: "B", name: "task", status: "completed" },
			{ id: "B", parentId: "A", name: "task", status: "completed" },
			{ id: "C", parentId: "A", name: "task", status: "completed" },
		]);
		assert.deepEqual(ids(tree.getChildren()), ["A", "B"]);
		assert.deepEqual(ids(tree.getChildren(tree.find("A"))), ["C"]);
	});
});

describe("AgentTreeProvider tooltip", () => {
	const appendMarkdown = MarkdownString.prototype.appendMarkdown;
	let markdown: string[];

	beforeEach(() => {
		stub.reset();
		markdown = [];
		MarkdownString.prototype.appendMarkdown = function (this: MarkdownString, value: string) {
			markdown.push(value);
			return appendMarkdown.call(this, value);
		};
	});

	afterEach(() => {
		MarkdownString.prototype.appendMarkdown = appendMarkdown;
	});

	it("adds the agent name and id as plain text", () => {
		const agent: AgentView = { id: "Anna`](https://x.example)", name: "Review](https://evil.example)", status: "running" };
		const tooltip = new AgentTreeProvider().getTreeItem(agent).tooltip as unknown as MarkdownString;
		assert.ok(tooltip.value.includes(agent.name));
		assert.ok(tooltip.value.includes(agent.id));
		assert.ok(markdown.every(value => !value.includes("evil.example") && !value.includes("x.example")), `appended as Markdown: ${markdown.join(" | ")}`);
	});
});
