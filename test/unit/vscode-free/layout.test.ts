import * as assert from "node:assert/strict";
import manifest from "../../../package.json";

interface ManifestView {
	id: string;
	type?: string;
	when?: string;
}

const containers = manifest.contributes.viewsContainers as Record<string, Array<{ id: string }>>;
const views = manifest.contributes.views as Record<string, ManifestView[]>;

describe("view containers in the manifest", () => {
	it("requires VS Code 1.106, the first release that honors viewsContainers.secondarySidebar", () => {
		const match = /^\^(\d+)\.(\d+)\.\d+$/.exec(manifest.engines.vscode);
		assert.ok(match, `engines.vscode ${manifest.engines.vscode} is not a caret range`);
		assert.ok(Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 106));
	});

	it("contributes only a Secondary Side Bar container", () => {
		assert.deepEqual(Object.keys(containers), ["secondarySidebar"]);
	});

	it("puts every view in an existing container, without visibility conditions", () => {
		const ids = Object.values(containers).flatMap(list => list.map(container => container.id));
		assert.deepEqual(Object.keys(views).sort(), [...ids].sort());
		assert.deepEqual(
			Object.values(views)
				.flat()
				.map(view => [view.id, view.type ?? "tree", view.when]),
			[
				["omp.chat", "webview", undefined],
				["omp.agents", "tree", undefined],
				["omp.changes", "tree", undefined],
			],
		);
	});

	it("declares only the properties VS Code reads on a view container", () => {
		for (const list of Object.values(containers)) {
			for (const container of list) assert.deepEqual(Object.keys(container).sort(), ["icon", "id", "title"]);
		}
	});

	it("gives a welcome text only to views that exist", () => {
		const viewIds = new Set(
			Object.values(views)
				.flat()
				.map(view => view.id),
		);
		for (const welcome of manifest.contributes.viewsWelcome) assert.ok(viewIds.has(welcome.view), welcome.view);
	});
});
