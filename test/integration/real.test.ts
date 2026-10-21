import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { OmpExtensionApi } from "../../src/extension";
import type { OmpServiceApi } from "../../src/omp/api";

/** The suite starts only once OMP is ready, so the service is always present. */
type ReadyApi = OmpExtensionApi & { readonly service: OmpServiceApi };

const workspace = process.env.OMP_IT_WORKSPACE!;

/** Polls state owned by the real OMP child process; turn durations depend on the model provider. */
async function until<T>(what: string, probe: () => T | undefined | null | false | "" | 0, timeoutMs = 120_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 100));
	}
}

/** `OMP_IT_MODEL=<provider>/<model id>`: the model the real turns run on; without it they are skipped. */
const requestedModel = /^([^/]+)\/(.+)$/.exec(process.env.OMP_IT_MODEL ?? "");

/**
 * Runs against a real OMP installation (`npm run test:real`). Sends real model
 * requests, so it is opt-in and not part of `npm test`. The model and effort it
 * selects are put back afterwards, in case OMP keeps them as defaults.
 */
describe("oh-my-pi extension (real OMP)", function () {
	this.timeout(240_000);
	let api: ReadyApi;
	let previous: { provider: string; id: string; thinking: string | undefined } | undefined;

	before(async () => {
		const activated = await vscode.extensions.getExtension<OmpExtensionApi>("oh-my-pi.oh-my-pi")!.activate();
		await vscode.commands.executeCommand("omp.openConversation");
		await until("ready", () => activated.service?.connection.state === "ready", 60_000);
		api = activated as ReadyApi;
		const { model, thinkingSelector, thinkingLevel } = api.service.session;
		if (model) previous = { provider: model.provider, id: model.id, thinking: thinkingSelector ?? thinkingLevel };
	});

	after(async () => {
		if (!previous || !api) return;
		await api.service.setModel(previous.provider, previous.id);
		if (previous.thinking) await api.service.setThinkingLevel(previous.thinking);
	});

	it("connects with protocol v2 and discovers configured models", async () => {
		assert.equal(api.service.connection.protocolVersion, 2);
		const models = await api.service.listModels();
		assert.ok(models.length > 0);
	});

	it("switches to the model named by OMP_IT_MODEL", async function () {
		if (!requestedModel) this.skip();
		const [, provider, id] = requestedModel;
		const models = await api.service.listModels();
		assert.ok(
			models.some(m => m.provider === provider && m.id === id),
			`${provider}/${id} is configured in this environment`,
		);
		await api.service.setModel(provider, id);
		assert.equal(api.service.session.model?.id, id);
	});

	it("offers OMP's auto effort, keeps it across a real turn and leaves it for an explicit level", async function () {
		if (!requestedModel) this.skip();
		assert.ok(api.service.session.availableThinkingLevels.includes("auto"));
		await api.service.setThinkingLevel("auto");
		assert.equal(api.service.session.thinkingSelector, "auto");
		const outcome = await api.service.prompt("Reply with exactly: ok");
		assert.equal(outcome.status, "completed");
		assert.equal(api.service.session.thinkingSelector, "auto");
		assert.ok(api.service.session.thinkingResolved, "OMP reported the effort auto resolved to");
		await api.service.setThinkingLevel("low");
		assert.deepEqual([api.service.session.thinkingSelector, api.service.session.thinkingLevel], ["low", "low"]);
		await api.service.setThinkingLevel("auto");
	});

	it("runs a real edit, renders it, tracks the change and opens a native diff", async function () {
		if (!requestedModel) this.skip();
		const file = path.join(workspace, "sample.txt");
		const outcome = await api.service.prompt("Use your edit tool to change the line 'beta' to 'gamma' in sample.txt. Reply with exactly DONE.");
		assert.equal(outcome.status, "completed");
		assert.match(fs.readFileSync(file, "utf8"), /gamma/);
		assert.ok(api.service.transcript.some(i => i.kind === "tool" && i.name === "edit"));
		await until("rendered", () => (api.chat.lastRendered?.counts.tool ?? 0) >= 1 && api.chat.lastRendered?.lastAssistantText);
		await until("tracked change", () => api.changes.changes.some(c => c.path === file));
		await vscode.commands.executeCommand("omp.changes.openDiff", vscode.Uri.file(file));
		await until("diff tab", () => vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputTextDiff)), 10_000);
	});
});
