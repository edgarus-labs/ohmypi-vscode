import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Logger, OmpServiceApi, SessionBinding, SessionView } from "./omp/api";
import { OmpService } from "./omp/service";
import { errorMessage } from "./shared/errors";
import { AgentTreeProvider } from "./ui/AgentTreeProvider";
import { ChatView } from "./ui/ChatView";
import { registerCommands } from "./ui/commands";
import { InteractionController, PresentationHandler } from "./ui/interactions";
import { chatViewIds, LAYOUT_CONTEXT, layoutContextValue, type OmpViewIds, supportsSecondarySidebar } from "./ui/layout";
import { ModelPreferences } from "./ui/modelPreferences";
import { ServiceSupervisor } from "./ui/ServiceSupervisor";
import { OmpStatusBar } from "./ui/StatusBar";
import { readServiceSettings } from "./ui/serviceSettings";
import { TodoDismissals } from "./ui/todoDismissals";
import { BASELINE_SCHEME } from "./vscode/BaselineContentProvider";
import { ChangeTracker } from "./vscode/ChangeTracker";
import { VsCodeHostTools } from "./vscode/hostTools/VsCodeHostTools";
import { OutputLogger } from "./vscode/logger";
import { DOC_SCHEME, VirtualDocuments } from "./vscode/VirtualDocuments";
import { openToolFile } from "./vscode/workspaceFiles";

const LAST_SESSION_KEY = "omp.lastSessionFile";
const RESTART_SETTINGS = ["omp.executablePath", "omp.extraArgs", "omp.autoRestart"];

/** Returned from `activate()`; used by integration tests. */
export interface OmpExtensionApi {
	readonly service: OmpServiceApi | undefined;
	readonly chat: ChatView;
	readonly agents: AgentTreeProvider;
	readonly changes: ChangeTracker;
}

function workingDirectory(): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) return folder.uri.fsPath;
	const active = vscode.window.activeTextEditor?.document.uri;
	if (active?.scheme === "file") return path.dirname(active.fsPath);
	return os.homedir();
}

/** Wires the OMP service into every VS Code surface. */
class OmpHost implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	readonly chat: ChatView;
	readonly agents = new AgentTreeProvider();
	readonly changes: ChangeTracker;
	private readonly supervisor: ServiceSupervisor;
	private readonly interactions: InteractionController;
	private readonly presentations: PresentationHandler;
	private readonly statusBar = new OmpStatusBar();
	private readonly docs = new VirtualDocuments();
	private readonly viewIds: OmpViewIds;
	private readonly agentsView: vscode.TreeView<unknown>;
	private readonly changesView: vscode.TreeView<unknown>;
	private readonly hostTools = new VsCodeHostTools(() => this.supervisor.service?.cwd ?? workingDirectory());

	constructor(
		private readonly context: vscode.ExtensionContext,
		output: vscode.OutputChannel,
		private readonly logger: Logger,
	) {
		const secondary = supportsSecondarySidebar(vscode.version);
		void vscode.commands.executeCommand("setContext", LAYOUT_CONTEXT, layoutContextValue(secondary));
		this.viewIds = chatViewIds(secondary);
		this.changes = new ChangeTracker(logger);
		const todoDismissals = new TodoDismissals(context.globalState);
		this.chat = new ChatView(
			context.extensionUri,
			this.viewIds.chat,
			logger,
			{
				ensureService: () => this.supervisor.ensureService(),
				pendingInteractions: () => this.interactions.list(),
				respond: (id, response) => this.interactions.respond(id, response),
				openFile: (filePath, line) => openToolFile(filePath, line, this.supervisor.service?.cwd ?? workingDirectory()),
				openToolDiff: (toolCallId, file) => this.openToolDiff(toolCallId, file),
				dismissedTodos: () => todoDismissals.list(),
				dismissTodos: key => todoDismissals.add(key),
			},
			context.extensionMode === vscode.ExtensionMode.Test,
		);
		this.interactions = new InteractionController(this.chat, logger);
		this.presentations = new PresentationHandler(this.chat, logger);
		this.agentsView = vscode.window.createTreeView(this.viewIds.agents, { treeDataProvider: this.agents, showCollapseAll: true });
		this.changesView = vscode.window.createTreeView(this.viewIds.changes, { treeDataProvider: this.changes });
		this.agentsView.description = this.agents.summary() || undefined;
		this.changesView.description = this.changes.summary() || undefined;
		const viewMessages = {
			setService: (service: OmpServiceApi | undefined) => {
				if (!service) return;
				this.agentsView.message = undefined;
				this.changesView.message = undefined;
			},
		};
		this.supervisor = new ServiceSupervisor({
			create: () => this.createService(),
			consumers: [viewMessages, this.chat, this.agents, this.changes, this.interactions, this.presentations, this.statusBar],
			showUnavailable: message => this.showUnavailable(message),
			resumeOptions: preferred => this.resumeOptions(preferred),
			onSession: session => this.onSessionChanged(session),
			logger,
			output,
		});
		this.disposables.push(
			this.supervisor,
			this.hostTools,
			this.chat,
			this.agents,
			this.changes,
			this.interactions,
			this.presentations,
			this.statusBar,
			this.agentsView,
			this.changesView,
			this.agents.onDidChangeSummary(summary => (this.agentsView.description = summary || undefined)),
			this.changes.onDidChangeSummary(summary => (this.changesView.description = summary || undefined)),
			vscode.window.registerWebviewViewProvider(this.viewIds.chat, this.chat, { webviewOptions: { retainContextWhenHidden: true } }),
			vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, this.changes.contentProvider),
			vscode.workspace.registerTextDocumentContentProvider(DOC_SCHEME, this.docs),
			vscode.workspace.onDidChangeConfiguration(event => this.onConfigurationChanged(event)),
			...registerCommands({
				ensureService: options => this.supervisor.ensureService(options),
				needsStart: () => this.supervisor.needsStart(),
				currentService: () => this.supervisor.service,
				restart: () => this.supervisor.restart(),
				chat: this.chat,
				viewIds: this.viewIds,
				agents: this.agents,
				changes: this.changes,
				docs: this.docs,
				output,
				logger,
				modelPreferences: new ModelPreferences(context.globalState),
			}),
		);
	}

	get api(): OmpExtensionApi {
		const supervisor = this.supervisor;
		return {
			get service() {
				return supervisor.service;
			},
			chat: this.chat,
			agents: this.agents,
			changes: this.changes,
		};
	}

	initialize(): void {
		this.supervisor.initialize();
	}

	private resumeOptions(preferred?: string): SessionBinding | undefined {
		if (preferred && fs.existsSync(preferred)) return { resumeSessionFile: preferred };
		const last = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
		if (!last) return undefined;
		if (fs.existsSync(last)) return { resumeSessionFile: last };
		this.logger.info(`Last session file no longer exists: ${last}`);
		return undefined;
	}

	private createService(): OmpServiceApi {
		const settings = readServiceSettings(vscode.workspace.getConfiguration("omp"), process.env, process.platform);
		const cwd = workingDirectory();
		this.logger.info(`Using OMP executable ${settings.executable} (cwd ${cwd})`);
		return new OmpService({ ...settings, cwd, logger: this.logger, hostTools: this.hostTools });
	}

	private showUnavailable(message: string): void {
		this.chat.setUnavailable(message);
		this.statusBar.setUnavailable(message);
		this.agentsView.message = message;
		this.changesView.message = message;
	}

	private onSessionChanged(session: SessionView): void {
		if (session.sessionFile && session.sessionFile !== this.context.workspaceState.get<string>(LAST_SESSION_KEY)) {
			this.context.workspaceState.update(LAST_SESSION_KEY, session.sessionFile).then(undefined, error =>
				this.logger.error("Failed to persist last session file", error),
			);
		}
	}

	private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
		if (!RESTART_SETTINGS.some(setting => event.affectsConfiguration(setting))) return;
		void vscode.window.showInformationMessage("OMP settings changed. Restart OMP to apply them?", "Restart").then(async choice => {
			if (choice !== "Restart") return;
			try {
				await this.supervisor.recreate();
			} catch (error) {
				this.logger.error("OMP restart after settings change failed", error);
				void vscode.window.showErrorMessage(`OMP restart failed: ${errorMessage(error)}`);
			}
		});
	}

	private async openToolDiff(toolCallId: string, file?: string): Promise<void> {
		const item = this.supervisor.service?.transcript.find(candidate => candidate.id === toolCallId);
		if (item?.kind !== "tool") {
			void vscode.window.showWarningMessage("That tool call is no longer in the transcript.");
			return;
		}
		await this.changes.whenIdle();
		if (!(await this.changes.openToolDiff(item, file))) {
			void vscode.window.showInformationMessage(file === undefined ? "No diff recorded for this tool call." : `No diff recorded for ${file} in this tool call.`);
		}
	}

	stop(): Promise<void> {
		return this.supervisor.shutdown();
	}

	dispose(): void {
		this.disposables.forEach(disposable => disposable.dispose());
	}
}

let active: { host: OmpHost; output: vscode.OutputChannel } | undefined;

export function activate(context: vscode.ExtensionContext): OmpExtensionApi {
	const output = vscode.window.createOutputChannel("oh-my-pi");
	const logger = new OutputLogger(output);
	const created = new OmpHost(context, output, logger);
	active = { host: created, output };
	context.subscriptions.push(created);
	created.initialize();
	return created.api;
}

/** Stops OMP. VS Code disposes the subscriptions without waiting for this, so the output channel closes only once OMP has stopped. */
export function deactivate(): Promise<void> | undefined {
	const current = active;
	active = undefined;
	return current?.host.stop().finally(() => current.output.dispose());
}
