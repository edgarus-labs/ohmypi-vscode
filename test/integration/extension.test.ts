import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { InteractionRequest, OmpServiceApi, SessionView } from "../../src/omp/api";
import type { Attachment } from "../../src/webview/protocol";

interface RenderedSnapshot {
	counts: Record<string, number>;
	lastAssistantText?: string;
	interactions: string[];
	collapsedTools?: number;
	attachments?: string[];
}

interface TestApi {
	service: OmpServiceApi;
	chat: {
		readonly visible: boolean;
		lastRendered?: RenderedSnapshot;
		onDidRender: vscode.Event<RenderedSnapshot>;
		send(text: string, mode: "auto", includeContext: boolean, attachments: Attachment[]): Promise<{ status: string }>;
	};
	changes: { readonly changes?: ReadonlyArray<{ path: string }> };
}

function webviewTabs(): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(tab => tab.input instanceof vscode.TabInputWebview));
}

const workspace = process.env.OMP_IT_WORKSPACE!;
const fakeLog = process.env.FAKE_OMP_LOG!;

function sentCommands(): Array<Record<string, unknown>> {
	if (!fs.existsSync(fakeLog)) return [];
	return fs
		.readFileSync(fakeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Polls a condition on state owned by a separate OMP child process and the webview,
 * which expose no single completion signal for every assertion below.
 */
async function until<T>(what: string, probe: () => T | undefined | null | false | "" | 0, timeoutMs = 10_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise(r => setTimeout(r, 50));
	}
}

function nextInteraction(service: OmpServiceApi): Promise<InteractionRequest> {
	const { promise, resolve } = Promise.withResolvers<InteractionRequest>();
	const sub = service.onInteractionRequest(request => {
		sub.dispose();
		resolve(request);
	});
	return promise;
}

describe("oh-my-pi extension (fake OMP)", () => {
	let api: TestApi;

	before(async () => {
		const ext = vscode.extensions.getExtension<TestApi>("oh-my-pi.oh-my-pi");
		assert.ok(ext, "extension is installed in the dev host");
		api = await ext.activate();
		await vscode.commands.executeCommand("omp.openConversation");
		await until("connection ready", () => api.service.connection.state === "ready");
	});

	it("shows the conversation as a webview view in the Secondary Sidebar, not as an editor tab", async () => {
		const contributes = vscode.extensions.getExtension("oh-my-pi.oh-my-pi")!.packageJSON.contributes;
		const [container] = contributes.viewsContainers.secondarySidebar as Array<{ id: string }>;
		assert.deepEqual(
			(contributes.views[container.id] as Array<{ id: string; type?: string }>).map(view => [view.id, view.type ?? "tree"]),
			[
				["omp.chat", "webview"],
				["omp.agents", "tree"],
				["omp.changes", "tree"],
			],
		);
		await until("chat view visible", () => api.chat.visible);
		assert.equal(webviewTabs().length, 0, "no editor-area conversation tab");
	});

	it("omp.sendPrompt reveals a hidden chat view and renders it", async () => {
		await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
		await until("chat hidden", () => !api.chat.visible);
		const { promise: rendered, resolve } = Promise.withResolvers<RenderedSnapshot>();
		const sub = api.chat.onDidRender(report => {
			sub.dispose();
			resolve(report);
		});
		await vscode.commands.executeCommand("omp.sendPrompt");
		await until("chat revealed", () => api.chat.visible);
		await rendered;
	});

	it("labels the reveal command as opening OMP in the side bar", () => {
		const commands = vscode.extensions.getExtension("oh-my-pi.oh-my-pi")!.packageJSON.contributes.commands as Array<{ command: string; title: string }>;
		assert.equal(commands.find(c => c.command === "omp.openConversation")?.title, "Open in Side Bar");
	});

	it("adds files to the chat as chips and sends them to OMP as @mentions", async () => {
		const sample = vscode.Uri.file(path.join(workspace, "sample.txt"));
		const other = vscode.Uri.file(path.join(workspace, ".vscode", "settings.json"));
		await vscode.commands.executeCommand("omp.addFileToChat", sample);
		await vscode.commands.executeCommand("omp.addFileToChat", other);
		await until("file chips", () => api.chat.lastRendered?.attachments?.join(",") === "sample.txt,settings.json");
		const outcome = await api.chat.send("compare these", "auto", false, [
			{ id: "a", kind: "file", path: sample.fsPath, label: "sample.txt" },
			{ id: "b", kind: "file", path: other.fsPath, label: "settings.json" },
		]);
		assert.equal(outcome.status, "completed");
		assert.ok(sentCommands().some(c => c.type === "prompt" && c.message === "compare these\n\nAttached: @sample.txt @.vscode/settings.json"));
	});

	it("toggles fast mode through OMP", async () => {
		const before = api.service.session.fastModeEnabled === true;
		await vscode.commands.executeCommand("omp.toggleFastMode");
		await until("fast mode toggled", () => api.service.session.fastModeEnabled === !before);
		assert.ok(sentCommands().some(c => c.type === "set_fast_mode" && c.enabled === !before));
		await vscode.commands.executeCommand("omp.toggleFastMode");
		await until("fast mode restored", () => api.service.session.fastModeEnabled === before);
	});

	it("renames the session through OMP", async () => {
		await vscode.commands.executeCommand("omp.renameSession", "Refactor parser");
		assert.equal(api.service.session.sessionName, "Refactor parser");
		assert.ok(sentCommands().some(c => c.type === "set_session_name" && c.name === "Refactor parser"));
	});

	it("1-4: activates, spawns OMP, completes the RPC handshake and creates a session", async () => {
		const status = api.service.connection;
		assert.equal(status.state, "ready");
		assert.ok(status.pid && status.pid > 0);
		assert.equal(status.protocolVersion, 2);
		const session = await until("session file", () => api.service.session.sessionFile && api.service.session);
		assert.ok(fs.existsSync(session.sessionFile!));
		assert.ok(sentCommands().some(c => c.type === "new_session"));
	});

	it("discovers models from OMP and switches the session model", async () => {
		const models = await api.service.listModels();
		assert.ok(models.length >= 2);
		const target = models.find(m => m.id !== api.service.session.model?.id)!;
		await api.service.setModel(target.provider, target.id);
		await until("model change", () => api.service.session.model?.id === target.id);
		assert.ok(sentCommands().some(c => c.type === "set_model" && c.modelId === target.id));
	});

	it("5-8,12-13: streams assistant output, renders it and settles only at session_settled", async () => {
		const phases: SessionView["phase"][] = [];
		const sub = api.service.onDidChangeSession(s => phases.push(s.phase));
		const outcome = await api.service.prompt("hello there");
		sub.dispose();
		assert.equal(outcome.status, "completed");
		assert.ok(phases.includes("running"));
		await until("idle", () => api.service.session.phase === "idle");
		const assistant = api.service.transcript.filter(i => i.kind === "assistant");
		assert.ok(assistant.length > 0 && assistant.at(-1)!.kind === "assistant");
		const rendered = await until("webview render", () => api.chat.lastRendered?.lastAssistantText && api.chat.lastRendered);
		assert.ok((rendered.counts.assistant ?? 0) >= 1);
		assert.ok((rendered.counts.user ?? 0) >= 1);
	});

	it("8: renders tool events and tracks the changed file for native diff", async () => {
		const file = path.join(workspace, "sample.txt");
		await api.service.prompt(`tool ${file}`);
		await until("tool items", () => api.service.transcript.filter(i => i.kind === "tool").length >= 2);
		const rendered = await until("rendered tools", () => (api.chat.lastRendered?.counts.tool ?? 0) >= 2 && api.chat.lastRendered);
		assert.ok((rendered.collapsedTools ?? 0) >= 2, "tool rows render collapsed by default");
		await until("tracked change", () => api.changes.changes?.some(c => c.path === file));
		await vscode.commands.executeCommand("omp.changes.openDiff", vscode.Uri.file(file));
		await until("diff editor", () =>
			vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.input instanceof vscode.TabInputTextDiff)),
		);
	});

	it("tracks an edit even when OMP changed the file before the host saw the tool start", async () => {
		const file = path.join(workspace, "racy.txt");
		fs.writeFileSync(file, "original\n");
		await api.service.prompt(`racyedit ${file}`);
		await until("tracked racy change", () => api.changes.changes?.some(c => c.path === file), 3000);
		await vscode.commands.executeCommand("omp.changes.openDiff", vscode.Uri.file(file));
		const diff = await until("racy diff", () =>
			vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath === file),
		);
		const original = await vscode.workspace.openTextDocument((diff.input as vscode.TabInputTextDiff).original);
		assert.equal(original.getText(), "original\n", "the diff baseline is the content before OMP's edit");
	});

	it("closes change diffs from the previous session when a new session starts", async () => {
		const file = path.join(workspace, "sample.txt");
		const baselineDiffs = () =>
			vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === "omp-base");
		await until("tracked change", () => api.changes.changes?.some(c => c.path === file));
		await vscode.commands.executeCommand("omp.changes.openDiff", vscode.Uri.file(file));
		await until("baseline diff open", () => baselineDiffs().length > 0);
		await vscode.commands.executeCommand("omp.newSession");
		await until("changes cleared", () => api.changes.changes?.length === 0);
		await until("stale diffs closed", () => baselineDiffs().length === 0, 3000);
	});

	it("9: renders subagent events in the agent hub", async () => {
		await api.service.prompt("subagent please");
		const agents = await until("subagents", () => api.service.agents.length >= 3 && api.service.agents);
		assert.ok(agents.some(a => a.id === "main"));
		assert.ok(agents.filter(a => a.id !== "main").every(a => a.status === "completed"));
	});

	it("10-11: displays an approval request and delivers the response to OMP", async () => {
		const pending = nextInteraction(api.service);
		const done = api.service.prompt("approve this");
		const request = await pending;
		assert.equal(request.kind, "confirm");
		await until("interaction rendered", () => api.chat.lastRendered?.interactions.includes(request.id));
		api.service.respondInteraction(request.id, { kind: "confirmed", confirmed: true });
		await done;
		assert.ok(sentCommands().some(c => c.type === "extension_ui_response" && c.id === request.id && c.confirmed === true));
	});

	it("14: cancellation aborts a running turn", async () => {
		const done = api.service.prompt("slow stream");
		await until("running", () => api.service.session.phase === "running");
		await vscode.commands.executeCommand("omp.abort");
		const outcome = await done;
		assert.equal(outcome.status, "aborted");
		await until("idle after abort", () => api.service.session.phase === "idle");
	});

	it("15-16: survives an OMP crash, restarts and keeps the session", async () => {
		const before = api.service.connection.pid;
		const file = api.service.session.sessionFile;
		const outcome = await api.service.prompt("crash now");
		assert.equal(outcome.status, "error");
		await until("restarted", () => api.service.connection.state === "ready" && api.service.connection.pid !== before, 15_000);
		assert.equal(api.service.session.sessionFile, file);
		const again = await api.service.prompt("hello after restart");
		assert.equal(again.status, "completed");
	});

	it("restart command replaces the process and the old pid is gone", async () => {
		const before = api.service.connection.pid!;
		await vscode.commands.executeCommand("omp.restart");
		await until("ready", () => api.service.connection.state === "ready" && api.service.connection.pid !== before);
		assert.throws(() => process.kill(before, 0));
	});

	it("resumes a stored session", async () => {
		const first = api.service.session.sessionFile!;
		await api.service.newSession();
		await until("new file", () => api.service.session.sessionFile && api.service.session.sessionFile !== first);
		const sessions = await api.service.listSessions();
		assert.ok(sessions.some(s => s.path === first));
		await api.service.switchSession(first);
		await until("switched back", () => api.service.session.sessionFile === first);
		assert.ok(api.service.transcript.some(i => i.kind === "user"));
	});

	it("switches sessions by file path", async () => {
		const first = api.service.session.sessionFile!;
		await api.service.newSession();
		await until("new file", () => api.service.session.sessionFile && api.service.session.sessionFile !== first);
		await vscode.commands.executeCommand("omp.switchSession", first);
		await until("switched by command", () => api.service.session.sessionFile === first);
		assert.ok(sentCommands().some(c => c.type === "switch_session" && c.sessionPath === first));
	});
});
