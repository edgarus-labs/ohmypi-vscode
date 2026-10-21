import * as assert from "node:assert/strict";
import { DOC_SCHEME, VirtualDocuments } from "../../src/vscode/VirtualDocuments";
import { stub, type Uri } from "./stubs/vscode";

describe("VirtualDocuments", () => {
	beforeEach(() => stub.reset());

	async function shown(docs: VirtualDocuments, name: string, content: string): Promise<Uri> {
		await docs.show(name, content);
		const opened = stub.callsTo("workspace.openTextDocument");
		return opened[opened.length - 1][0] as Uri;
	}

	it("opens generated content as a read-only document", async () => {
		const docs = new VirtualDocuments();
		const uri = await shown(docs, "agent/a.md", "# Agent");
		assert.equal(uri.scheme, DOC_SCHEME);
		assert.equal(uri.path, "/agent_a.md");
		assert.equal(docs.provideTextDocumentContent(uri as never), "# Agent");
		assert.equal(stub.callsTo("window.showTextDocument").length, 1);
	});

	it("fails instead of serving an empty document once the content is no longer kept", async () => {
		const docs = new VirtualDocuments();
		const first = await shown(docs, "first.md", "first");
		for (let i = 0; i < 20; i++) await docs.show(`doc${i}.md`, `doc ${i}`);
		assert.throws(() => docs.provideTextDocumentContent(first as never), /no longer available/);
	});

	it("addresses its documents apart from those of an earlier activation", async () => {
		const earlier = await shown(new VirtualDocuments(), "agent-main.md", "old");
		const current = await shown(new VirtualDocuments(), "agent-main.md", "new");
		assert.notEqual(current.toString(), earlier.toString());
	});

	it("forgets the oldest documents once their text exceeds the character budget, keeping the newest", async () => {
		const docs = new VirtualDocuments(10);
		const first = await shown(docs, "a.md", "aaaaaa");
		const second = await shown(docs, "b.md", "bbbbbb");
		assert.throws(() => docs.provideTextDocumentContent(first as never), /no longer available/);
		assert.equal(docs.provideTextDocumentContent(second as never), "bbbbbb");
		const large = await shown(docs, "c.md", "c".repeat(20));
		assert.throws(() => docs.provideTextDocumentContent(second as never), /no longer available/);
		assert.equal(docs.provideTextDocumentContent(large as never), "c".repeat(20));
	});
});
