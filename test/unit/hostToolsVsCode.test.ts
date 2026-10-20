import * as assert from "node:assert/strict";
import * as path from "node:path";
import { VsCodeHostTools } from "../../src/vscode/hostTools/VsCodeHostTools";
import { stub } from "./stubs/vscode";

describe("VS Code host tools", () => {
	const cwd = path.resolve("/work/repo");
	let tools: VsCodeHostTools;
	const invoke = (name: string, args: Record<string, unknown>) => tools.invoke(name, args, new AbortController().signal);

	beforeEach(() => {
		stub.reset();
		tools = new VsCodeHostTools(() => cwd);
	});
	afterEach(() => tools.dispose());

	it("offers only vscode_ tools whose schemas reject unknown arguments", () => {
		assert.ok(tools.definitions.length > 0);
		for (const definition of tools.definitions) {
			assert.match(definition.name, /^vscode_[a-z_]+$/);
			assert.equal(definition.parameters.type, "object");
			assert.equal(definition.parameters.additionalProperties, false);
		}
	});

	it("rejects an unknown tool", async () => {
		await assert.rejects(invoke("vs_build", {}), { message: "Unknown tool: vs_build" });
	});

	it("rejects a path outside the workspace before touching it", async () => {
		const outside = path.resolve("/etc/hosts");
		await assert.rejects(invoke("vscode_read_document", { path: outside }), { message: `'path' must be inside the workspace (${cwd}): ${outside}` });
		assert.deepEqual(stub.callsTo("workspace.fs.stat"), []);
	});

	describe("vscode_find_commands", () => {
		beforeEach(() => {
			stub.on("commands.getCommands", () => [
				"workbench.action.files.save",
				"editor.action.formatSelection",
				"editor.action.formatDocument",
				"format.all",
				"formatter.pick",
				"git.commit",
			]);
		});

		it("lists ids containing the filter, ignoring case, prefix matches and shorter ids first", async () => {
			assert.equal(
				await invoke("vscode_find_commands", { filter: "FORMAT" }),
				"format.all\nformatter.pick\neditor.action.formatDocument\neditor.action.formatSelection",
			);
			assert.deepEqual(stub.callsTo("commands.getCommands"), [[true]]);
		});

		it("returns at most max ids", async () => {
			assert.equal(await invoke("vscode_find_commands", { filter: "format", max: 2 }), "format.all\nformatter.pick");
		});

		it("says so when nothing matches", async () => {
			assert.equal(await invoke("vscode_find_commands", { filter: "zzz" }), "No commands match 'zzz'.");
		});
	});
});
