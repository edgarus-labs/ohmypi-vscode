import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { BASELINE_SCHEME, BaselineContentProvider, baselineUri, EMPTY_QUERY } from "../../src/vscode/BaselineContentProvider";
import { EventEmitter, stub } from "./stubs/vscode";

describe("BaselineContentProvider", () => {
	const file = path.resolve("/work/src/a.ts");

	beforeEach(() => stub.reset());

	function provider(baseline: (filePath: string) => string | null | undefined = () => undefined) {
		return new BaselineContentProvider(baseline, new EventEmitter<vscode.Uri>().event);
	}

	it("addresses the baseline of a file under its own scheme", () => {
		const uri = baselineUri(file);
		assert.equal(uri.scheme, BASELINE_SCHEME);
		assert.equal(uri.path, vscode.Uri.file(file).path);
	});

	it("serves the tracked baseline of the file", () => {
		const asked: string[] = [];
		const content = provider(filePath => {
			asked.push(filePath);
			return "before";
		}).provideTextDocumentContent(baselineUri(file));
		assert.equal(content, "before");
		assert.deepEqual(asked, [vscode.Uri.file(file).fsPath]);
	});

	it("serves pinned content and an empty side", () => {
		const docs = provider(() => "tracked");
		assert.equal(docs.provideTextDocumentContent(docs.pin(file, "pinned")), "pinned");
		assert.equal(docs.provideTextDocumentContent(baselineUri(file, EMPTY_QUERY)), "");
	});

	it("serves an empty baseline for a file that did not exist", () => {
		assert.equal(provider(() => null).provideTextDocumentContent(baselineUri(file)), "");
	});

	it("fails instead of serving empty content for a baseline that is no longer kept", () => {
		assert.throws(() => provider().provideTextDocumentContent(baselineUri(file)), /no longer available/);
	});

	it("fails for a pin that was evicted", () => {
		const docs = provider();
		const first = docs.pin(file, "first");
		for (let i = 0; i < 20; i++) docs.pin(file, `pin ${i}`);
		assert.throws(() => docs.provideTextDocumentContent(first), /no longer available/);
	});
});
