import * as assert from "node:assert/strict";
import type { AgentView } from "../../src/omp/api";
import { AgentTreeProvider } from "../../src/ui/AgentTreeProvider";
import { MarkdownString, stub } from "./stubs/vscode";

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
