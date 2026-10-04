import * as assert from "node:assert/strict";
import { chatViewIds, supportsSecondarySidebar } from "../../../src/ui/layout";

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
