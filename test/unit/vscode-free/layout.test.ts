import * as assert from "node:assert/strict";
import manifest from "../../../package.json";
import { chatViewIds, LAYOUT_CONTEXT, layoutContextValue, supportsSecondarySidebar } from "../../../src/ui/layout";

interface ManifestView {
	id: string;
	when?: string;
}

describe("secondary sidebar support", () => {
	it("requires VS Code 1.106 or newer", () => {
		assert.equal(supportsSecondarySidebar("1.105.1"), false);
		assert.equal(supportsSecondarySidebar("1.106.0"), true);
		assert.equal(supportsSecondarySidebar("1.140.0-insider"), true);
		assert.equal(supportsSecondarySidebar("2.0.0"), true);
	});

	it("treats an unparsable version as unsupported", () => {
		assert.equal(supportsSecondarySidebar("insiders"), false);
	});

	it("selects the view ids of the active container", () => {
		assert.deepEqual(chatViewIds(true), { chat: "omp.chat", agents: "omp.agents", changes: "omp.changes" });
		assert.deepEqual(chatViewIds(false), { chat: "omp.chatSidebar", agents: "omp.agentsSidebar", changes: "omp.changesSidebar" });
	});
});

describe("view containers in the manifest", () => {
	const views = manifest.contributes.views as Record<string, ManifestView[]>;

	it("shows each container's views only once the host has chosen that container", () => {
		assert.deepEqual(
			views["omp-panel"].map(view => [view.id, view.when]),
			Object.values(chatViewIds(true)).map(id => [id, `${LAYOUT_CONTEXT} == ${layoutContextValue(true)}`]),
		);
		assert.deepEqual(
			views.omp.map(view => [view.id, view.when]),
			Object.values(chatViewIds(false)).map(id => [id, `${LAYOUT_CONTEXT} == ${layoutContextValue(false)}`]),
		);
		assert.notEqual(layoutContextValue(true), layoutContextValue(false));
	});

	it("declares only the properties VS Code reads on a view container", () => {
		for (const containers of Object.values(manifest.contributes.viewsContainers)) {
			for (const container of containers) assert.deepEqual(Object.keys(container).sort(), ["icon", "id", "title"]);
		}
	});
});
