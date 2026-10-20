import * as vscode from "vscode";
import type { AgentView, Logger, OmpServiceApi, SessionBinding } from "../omp/api";
import { errorMessage } from "../shared/errors";
import { relativeTime } from "../shared/format";
import { effortChoices } from "../shared/session";
import type { TrackedChange } from "../vscode/changeModel";
import type { ChangeTracker } from "../vscode/ChangeTracker";
import type { VirtualDocuments } from "../vscode/VirtualDocuments";
import type { AgentTreeProvider } from "./AgentTreeProvider";
import type { ChatView } from "./ChatView";
import { agentSummaryMarkdown, formatBytes, sessionTitle, transcriptToMarkdown } from "./format";
import type { OmpViewIds } from "./layout";
import { pickModel } from "./modelPicker";
import type { ModelPreferences } from "./modelPreferences";

export interface CommandDeps {
	/** Running service; starts OMP with `options` when it is not running yet. */
	ensureService(options?: SessionBinding): Promise<OmpServiceApi>;
	/** True when OMP has not been started (manual startup or after a failure). */
	needsStart(): boolean;
	currentService(): OmpServiceApi | undefined;
	restart(): Promise<void>;
	chat: ChatView;
	viewIds: OmpViewIds;
	agents: AgentTreeProvider;
	changes: ChangeTracker;
	docs: VirtualDocuments;
	output: vscode.OutputChannel;
	logger: Logger;
	/** Favorite and recent models and the model picker's filters. */
	modelPreferences: ModelPreferences;
}

const SETTINGS_QUERY = "@ext:oh-my-pi.oh-my-pi";

export async function openOmpSettings(): Promise<void> {
	await vscode.commands.executeCommand("workbench.action.openSettings", SETTINGS_QUERY);
}

async function pickAgent(deps: CommandDeps, agent: AgentView | undefined, placeHolder: string): Promise<AgentView | undefined> {
	if (agent) return deps.agents.find(agent.id) ?? agent;
	const pick = await vscode.window.showQuickPick(
		deps.agents.current.map(candidate => ({ label: candidate.name, description: `${candidate.id} · ${candidate.status}`, agent: candidate })),
		{ placeHolder },
	);
	return pick?.agent;
}

async function selectThinkingLevel(deps: CommandDeps): Promise<void> {
	const service = await deps.ensureService();
	const levels = service.session.availableThinkingLevels;
	if (levels.length === 0) {
		void vscode.window.showInformationMessage("The current model has no thinking levels.");
		return;
	}
	const { value: current, options } = effortChoices(service.session);
	const pick = await vscode.window.showQuickPick(
		options.map(option => ({
			label: `${option.value === current ? "$(check) " : ""}${option.label}`,
			description: option.value === "auto" ? "OMP picks the effort for each turn" : undefined,
			level: option.value,
		})),
		{ placeHolder: `Reasoning effort${current ? ` (current: ${current})` : ""}` },
	);
	if (pick) await service.setThinkingLevel(pick.level);
}

async function resumeSession(deps: CommandDeps): Promise<void> {
	const service = await deps.ensureService();
	const sessions = await service.listSessions();
	if (sessions.length === 0) {
		void vscode.window.showInformationMessage("No saved OMP sessions found.");
		return;
	}
	const currentFile = service.session.sessionFile;
	const now = Date.now();
	const pick = await vscode.window.showQuickPick(
		sessions.map(session => {
			const isCurrent = session.path === currentFile;
			const title = sessionTitle(session);
			return {
				label: `${isCurrent ? "$(check) " : ""}${title}`,
				description: `${relativeTime(session.modified, now)} · ${formatBytes(session.size)}${isCurrent ? " · current" : ""}`,
				detail: session.cwd,
				session,
			};
		}),
		{ placeHolder: "Resume OMP session", matchOnDescription: true, matchOnDetail: true },
	);
	if (!pick || pick.session.path === currentFile) return;
	await service.switchSession(pick.session.path);
}

async function sendPrompt(deps: CommandDeps): Promise<void> {
	await deps.chat.reveal();
	deps.chat.focusComposer();
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
	const register = (id: string, handler: (...args: never[]) => Promise<unknown> | unknown) =>
		vscode.commands.registerCommand(id, async (...args: never[]) => {
			try {
				await handler(...args);
			} catch (error) {
				deps.logger.error(`Command ${id} failed`, error);
				const choice = await vscode.window.showErrorMessage(`OMP: ${errorMessage(error)}`, "Show Log");
				if (choice === "Show Log") deps.output.show(true);
			}
		});

	return [
		register("omp.newSession", async () => {
			const fresh = deps.needsStart();
			const service = await deps.ensureService({ newSession: true });
			if (!fresh) await service.newSession();
			deps.changes.clear();
		}),
		register("omp.resumeSession", () => resumeSession(deps)),
		register("omp.openConversation", () => deps.chat.reveal()),
		register("omp.toggleFastMode", async () => {
			const service = await deps.ensureService();
			await service.setFastMode(service.session.fastModeEnabled !== true);
		}),
		register("omp.renameSession", async (name?: string) => {
			const service = await deps.ensureService();
			const next =
				typeof name === "string"
					? name
					: await vscode.window.showInputBox({
							title: "Rename OMP session",
							value: service.session.sessionName ?? "",
							validateInput: value => (value.trim() ? undefined : "Name cannot be empty"),
						});
			if (next?.trim()) await service.setSessionName(next.trim());
		}),
		register("omp.openSession", async () => {
			const file = deps.currentService()?.session.sessionFile;
			if (!file) {
				void vscode.window.showInformationMessage("No OMP session file yet.");
				return;
			}
			await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
			await vscode.commands.executeCommand("workbench.action.files.setActiveEditorReadonlyInSession");
		}),
		register("omp.selectModel", async () => pickModel(await deps.ensureService(), deps.modelPreferences)),
		register("omp.selectThinkingLevel", () => selectThinkingLevel(deps)),
		register("omp.sendPrompt", () => sendPrompt(deps)),
		register("omp.showUsage", async () => {
			await deps.chat.reveal();
			deps.chat.toggleUsage();
		}),
		register("omp.abort", async () => deps.currentService()?.abort()),
		register("omp.restart", () => deps.restart()),
		register("omp.openSettings", openOmpSettings),
		register("omp.showAgents", () => vscode.commands.executeCommand(`${deps.viewIds.agents}.focus`)),
		register("omp.addFileToChat", async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
			const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
			const uris = Array.isArray(selected) && selected.length > 0 ? selected : target ? [target] : [];
			if (uris.length === 0) {
				void vscode.window.showInformationMessage("Open a file or select files in the Explorer to add them to the OMP chat.");
				return;
			}
			await deps.chat.reveal({ preserveFocus: true });
			deps.chat.addFiles(uris);
		}),
		register("omp.showLog", () => deps.output.show(true)),
		register("omp.agent.inspect", async (arg?: AgentView) => {
			const agent = await pickAgent(deps, arg, "Inspect agent");
			if (agent) await deps.docs.show(`agent-${agent.id}.md`, agentSummaryMarkdown(agent, Date.now()));
		}),
		register("omp.agent.openTranscript", async (arg?: AgentView) => {
			const agent = await pickAgent(deps, arg, "Open agent transcript");
			if (!agent) return;
			const service = await deps.ensureService();
			const items = await service.getAgentTranscript(agent.id);
			await deps.docs.show(`${agent.name}-${agent.id}-transcript.md`, transcriptToMarkdown(`${agent.name} (${agent.id})`, items));
		}),
		register("omp.agent.steer", async (arg?: AgentView) => {
			const agent = await pickAgent(deps, arg, "Steer agent");
			if (!agent) return;
			const message = await vscode.window.showInputBox({ prompt: `Message for ${agent.name} (${agent.id})`, ignoreFocusOut: true });
			if (!message?.trim()) return;
			await (await deps.ensureService()).steerAgent(agent.id, message);
		}),
		register("omp.agent.cancel", async (arg?: AgentView) => {
			const agent = await pickAgent(deps, arg, "Cancel agent");
			if (!agent) return;
			const confirmed = await vscode.window.showWarningMessage(
				`Cancel agent ${agent.name} (${agent.id})?`,
				{ modal: true, detail: agent.activity },
				"Cancel Agent",
			);
			if (confirmed !== "Cancel Agent") return;
			const cancelled = await (await deps.ensureService()).cancelAgent(agent.id);
			if (!cancelled) void vscode.window.showInformationMessage(`Agent ${agent.name} was not running.`);
		}),
		register("omp.changes.openDiff", async (arg?: TrackedChange | vscode.Uri) => {
			const target = arg ?? deps.changes.changes[0];
			if (target) await deps.changes.openDiff(target);
		}),
		register("omp.changes.openFile", async (arg?: TrackedChange | vscode.Uri) => {
			if (!arg) return;
			await vscode.window.showTextDocument(arg instanceof vscode.Uri ? arg : vscode.Uri.file(arg.path), { preview: true });
		}),
		register("omp.changes.clear", () => deps.changes.clear()),
	];
}
