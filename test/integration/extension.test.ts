import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { OmpExtensionApi } from "../../src/extension";
import type { InteractionRequest, OmpServiceApi, SessionView } from "../../src/omp/api";
import { deferred } from "../../src/shared/deferred";
import { supportsSecondarySidebar } from "../../src/ui/layout";
import type { RenderedReport } from "../../src/webview/protocol";

/** The suite starts only once OMP is ready, so the service is always present. */
type ReadyApi = OmpExtensionApi & { readonly service: OmpServiceApi };

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
	const { promise, resolve } = deferred<InteractionRequest>();
	const sub = service.onInteractionRequest(request => {
		sub.dispose();
		resolve(request);
	});
	return promise;
}

describe("oh-my-pi extension (fake OMP)", () => {
	let api: ReadyApi;

	before(async () => {
		const ext = vscode.extensions.getExtension<OmpExtensionApi>("oh-my-pi.oh-my-pi");
		assert.ok(ext, "extension is installed in the dev host");
		const activated = await ext.activate();
		await vscode.commands.executeCommand("omp.openConversation");
		await until("connection ready", () => activated.service?.connection.state === "ready");
		api = activated as ReadyApi;
	});

	it("shows the conversation as a webview view, not as an editor tab", async () => {
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
		const sideBar = supportsSecondarySidebar(vscode.version) ? "workbench.action.closeAuxiliaryBar" : "workbench.action.closeSidebar";
		await vscode.commands.executeCommand(sideBar);
		await until("chat hidden", () => !api.chat.visible);
		const { promise: rendered, resolve } = deferred<RenderedReport>();
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
		assert.ok(sentCommands().some(c => c.type === "prompt" && c.message === `compare these\n\nAttached: @sample.txt @${path.join(".vscode", "settings.json")}`));
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

	it("activates, spawns OMP, completes the RPC handshake and creates a session", async () => {
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

	it("streams assistant output and renders the new reply", async () => {
		const phases: SessionView["phase"][] = [];
		const sub = api.service.onDidChangeSession(s => phases.push(s.phase));
		const outcome = await api.service.prompt("hello there");
		sub.dispose();
		assert.equal(outcome.status, "completed");
		assert.ok(phases.includes("running"));
		await until("idle", () => api.service.session.phase === "idle");
		const assistant = api.service.transcript.filter(i => i.kind === "assistant");
		assert.ok(assistant.length > 0 && assistant.at(-1)!.kind === "assistant");
		const rendered = await until("webview render", () => api.chat.lastRendered?.lastAssistantText?.includes("Echo: hello there") && api.chat.lastRendered);
		assert.ok((rendered.counts.assistant ?? 0) >= 1);
		assert.ok((rendered.counts.user ?? 0) >= 1);
	});

	it("lets OMP edit and read an open editor buffer through the vscode_ host tools", async () => {
		const registered = sentCommands().find(c => c.type === "set_host_tools");
		const names = ((registered?.tools ?? []) as Array<{ name: string }>).map(tool => tool.name);
		assert.ok(names.includes("vscode_replace_lines") && names.includes("vscode_read_document"), `registered: ${names.join(", ")}`);
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, "sample.txt")));
		await vscode.window.showTextDocument(document);
		const original = document.getText();
		try {
			await api.service.prompt('hosttool vscode_replace_lines {"path":"sample.txt","startLine":1,"endLine":0,"text":"first line from OMP"}');
			assert.equal(document.lineAt(0).text, "first line from OMP");
			assert.ok(document.isDirty, "the edit stays unsaved in the buffer");
			await api.service.prompt('hosttool vscode_read_document {"path":"sample.txt","startLine":1,"endLine":1}');
			const reply = api.service.transcript.filter(item => item.kind === "assistant").at(-1);
			assert.ok(reply?.kind === "assistant" && /^Host tool ok: [\s\S]*1[^\n]*first line from OMP/.test(reply.text), JSON.stringify(reply));
			await api.service.prompt('hosttool vscode_read_document {"path":"../outside.txt"}');
			const refused = api.service.transcript.filter(item => item.kind === "assistant").at(-1);
			assert.ok(refused?.kind === "assistant" && refused.text.startsWith("Host tool error:"), JSON.stringify(refused));
		} finally {
			await vscode.window.showTextDocument(document);
			await vscode.commands.executeCommand("workbench.action.files.revert");
			assert.equal(document.getText(), original);
		}
	});

	it("stays busy after the prompt result until OMP reports the session settled", async () => {
		let running = false;
		let finishedWhenIdle: boolean | undefined;
		const sub = api.service.onDidChangeSession(s => {
			if (s.phase !== "idle") running = true;
			else if (running && finishedWhenIdle === undefined) {
				finishedWhenIdle = api.service.transcript.some(i => i.kind === "assistant" && i.text.includes("Background job finished."));
			}
		});
		const outcome = await api.service.prompt("background job");
		assert.equal(outcome.sessionSettled, false);
		await until("idle after settling", () => finishedWhenIdle !== undefined);
		sub.dispose();
		assert.equal(finishedWhenIdle, true, "idle only after the background turn finished");
	});

	it("renders tool events and tracks the changed file for native diff", async () => {
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
			vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t => t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath === vscode.Uri.file(file).fsPath),
		);
		const original = await vscode.workspace.openTextDocument((diff.input as vscode.TabInputTextDiff).original);
		assert.equal(original.getText(), "original\n", "the diff baseline is the content before OMP's edit");
	});

	it("closes change diffs from the previous session when a new session starts", async () => {
		const file = path.join(workspace, "sample.txt");
		const baselineDiffs = () =>
			vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputTextDiff && t.input.original.scheme === "omp-base");
		await api.service.prompt(`tool ${file}`);
		await until("tracked change", () => api.changes.changes?.some(c => c.path === file));
		await vscode.commands.executeCommand("omp.changes.openDiff", vscode.Uri.file(file));
		await until("baseline diff open", () => baselineDiffs().length > 0);
		await vscode.commands.executeCommand("omp.newSession");
		await until("changes cleared", () => api.changes.changes?.length === 0);
		await until("stale diffs closed", () => baselineDiffs().length === 0, 3000);
	});

	it("renders subagent events in the agent hub", async () => {
		await api.service.prompt("subagent please");
		const agents = await until("subagents", () => api.service.agents.length >= 3 && api.service.agents);
		assert.ok(agents.some(a => a.id === "main"));
		assert.ok(agents.filter(a => a.id !== "main").every(a => a.status === "completed"));
	});

	it("displays an approval request and delivers the response to OMP", async () => {
		const pending = nextInteraction(api.service);
		const done = api.service.prompt("approve this");
		const request = await pending;
		assert.equal(request.kind, "confirm");
		await until("interaction rendered", () => api.chat.lastRendered?.interactions.includes(request.id));
		api.service.respondInteraction(request.id, { kind: "confirmed", confirmed: true });
		await done;
		assert.ok(sentCommands().some(c => c.type === "extension_ui_response" && c.id === request.id && c.confirmed === true));
	});

	it("aborts a running turn on cancellation", async () => {
		const done = api.service.prompt("slow stream");
		await until("running", () => api.service.session.phase === "running");
		await vscode.commands.executeCommand("omp.abort");
		const outcome = await done;
		assert.equal(outcome.status, "aborted");
		await until("idle after abort", () => api.service.session.phase === "idle");
	});

	it("survives an OMP crash, restarts and keeps the session", async () => {
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
		await api.service.prompt("remember this session");
		const first = api.service.session.sessionFile!;
		await api.service.newSession();
		await until("new file", () => api.service.session.sessionFile && api.service.session.sessionFile !== first);
		const sessions = await api.service.listSessions();
		assert.ok(sessions.some(s => s.path === first));
		await api.service.switchSession(first);
		await until("switched back", () => api.service.session.sessionFile === first);
		assert.ok(api.service.transcript.some(i => i.kind === "user"));
		assert.ok(sentCommands().some(c => c.type === "switch_session" && c.sessionPath === first));
	});

	it("offers the newest other saved sessions to the chat when the session changes", async () => {
		await vscode.commands.executeCommand("omp.openConversation");
		await until("chat view visible", () => api.chat.visible);
		const previous = api.service.session.sessionFile!;
		await api.service.prompt("recent session marker");
		await api.service.newSession();
		const current = await until("new file", () => api.service.session.sessionFile !== previous && api.service.session.sessionFile);
		const offered = await until("recent sessions offered", () => api.chat.offeredSessions[0]?.path === previous && api.chat.offeredSessions);
		assert.ok(offered.length <= 5);
		assert.ok(!offered.some(s => s.path === current), "the current session is not offered");
		assert.ok(offered.every(s => s.title.length > 0 && !s.title.includes("\n")));
	});
});
