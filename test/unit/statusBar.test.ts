import * as assert from "node:assert/strict";
import { OmpStatusBar } from "../../src/ui/StatusBar";
import { stub } from "./stubs/vscode";

describe("OmpStatusBar", () => {
	beforeEach(() => stub.reset());

	it("shows why OMP is unavailable without assuming the executable is missing", () => {
		const statusBar = new OmpStatusBar();
		statusBar.setUnavailable("OMP is disabled in Restricted Mode.");
		const [item] = stub.callsTo("statusBarItem.show")[0] as [{ text: string; tooltip: string }];
		assert.equal(item.text, "$(error) OMP: unavailable");
		assert.equal(item.tooltip, "OMP is disabled in Restricted Mode.");
		statusBar.dispose();
	});
});
