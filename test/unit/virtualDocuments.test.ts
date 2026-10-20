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
});
