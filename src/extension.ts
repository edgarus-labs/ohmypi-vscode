import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Disposable, Logger, OmpServiceApi, SessionView } from "./omp/api";
import { resolveExecutable } from "./omp/executable";
import { OmpService } from "./omp/service";
import { AgentTreeProvider } from "./ui/AgentTreeProvider";
import { ChatView } from "./ui/ChatView";
import { openOmpSettings, registerCommands, type StartOptions } from "./ui/commands";
import { InteractionController, PresentationHandler } from "./ui/interactions";
import { errorMessage } from "./ui/guards";
import { chatViewIds, type OmpViewIds, supportsSecondarySidebar } from "./ui/layout";
import { OmpStatusBar } from "./ui/StatusBar";
import { BASELINE_SCHEME } from "./vscode/BaselineContentProvider";
import { ChangeTracker } from "./vscode/ChangeTracker";
import { resolveToolPath } from "./vscode/changePaths";
import { OutputLogger } from "./vscode/logger";
import { DOC_SCHEME, VirtualDocuments } from "./vscode/VirtualDocuments";

const LAST_SESSION_KEY = "omp.lastSessionFile";
const RESTART_SETTINGS = ["omp.executablePath", "omp.extraArgs", "omp.autoRestart", "omp.traceRpc"];

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

/** Owns the OMP service lifecycle and wires it into every VS Code surface. */
class OmpHost implements vscode.Disposable {
	private service: OmpServiceApi | undefined;
	private starting: Promise<void> | undefined;
	private serviceSubscriptions: Disposable[] = [];
	private readonly disposables: vscode.Disposable[] = [];
	readonly chat: ChatView;
	readonly agents = new AgentTreeProvider();
	readonly changes: ChangeTracker;
	private readonly interactions: InteractionController;
	private readonly presentations: PresentationHandler;
	private readonly statusBar = new OmpStatusBar();
	private readonly docs = new VirtualDocuments();
	private readonly viewIds: OmpViewIds;
	private readonly agentsView: vscode.TreeView<unknown>;
	private readonly changesView: vscode.TreeView<unknown>;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
		private readonly logger: Logger,
	) {
		const secondary = supportsSecondarySidebar(vscode.version);
		void this.setContext("omp.noSecondarySidebar", !secondary);
		this.viewIds = chatViewIds(secondary);
		this.changes = new ChangeTracker(logger);
		this.chat = new ChatView(context.extensionUri, this.viewIds.chat, logger, {
			ensureService: () => this.ensureService(),
			pendingInteractions: () => this.interactions.list(),
			respond: (id, response) => this.interactions.respond(id, response),
			openFile: (filePath, line) => this.openFile(filePath, line),
			openToolDiff: toolCallId => this.openToolDiff(toolCallId),
		});
		this.interactions = new InteractionController(this.chat, logger);
		this.presentations = new PresentationHandler(this.chat, logger);
		this.agentsView = vscode.window.createTreeView(this.viewIds.agents, { treeDataProvider: this.agents, showCollapseAll: true });
		this.changesView = vscode.window.createTreeView(this.viewIds.changes, { treeDataProvider: this.changes });
		this.agentsView.description = this.agents.summary() || undefined;
		this.changesView.description = this.changes.summary() || undefined;
		this.disposables.push(
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
				ensureService: options => this.ensureService(options),
				needsStart: () => this.needsStart(),
				currentService: () => this.service,
				restart: () => this.restart(),
				chat: this.chat,
				viewIds: this.viewIds,
				agents: this.agents,
				changes: this.changes,
				docs: this.docs,
				output,
				logger,
			}),
		);
		void this.setContext("omp.busy", false);
		void this.setContext("omp.hasThinkingLevels", false);
	}

	get api(): OmpExtensionApi {
		const host = this;
		return {
			get service() {
				return host.service;
			},
			chat: this.chat,
			agents: this.agents,
			changes: this.changes,
		};
	}

	/** Creates the service and starts it according to `omp.startup`. */
	initialize(): void {
		if (!this.createService()) return;
		const startup = vscode.workspace.getConfiguration("omp").get<string>("startup", "resumeLast");
		if (startup === "manual") {
			this.logger.info("Startup mode manual: OMP starts on the first command");
			return;
		}
		this.startInBackground(startup === "newSession" ? { newSession: true } : this.resumeOptions());
	}

	private resumeOptions(): StartOptions | undefined {
		const last = this.context.workspaceState.get<string>(LAST_SESSION_KEY);
		if (!last) return undefined;
		if (fs.existsSync(last)) return { resumeSessionFile: last };
		this.logger.info(`Last session file no longer exists: ${last}`);
		return undefined;
	}

	private createService(): boolean {
		const config = vscode.workspace.getConfiguration("omp");
		let executable: string;
		try {
			executable = resolveExecutable(config.get<string>("executablePath", ""), process.env, process.platform);
		} catch (error) {
			this.markUnavailable(errorMessage(error));
			return false;
		}
		const cwd = workingDirectory();
		this.logger.info(`Using OMP executable ${executable} (cwd ${cwd})`);
		const service: OmpServiceApi = new OmpService({
			executable,
			extraArgs: config.get<string[]>("extraArgs", []),
			cwd,
			logger: this.logger,
			autoRestart: config.get<boolean>("autoRestart", true),
			traceRpc: config.get<boolean>("traceRpc", false),
		});
		this.service = service;
		this.agentsView.message = undefined;
		this.changesView.message = undefined;
		this.serviceSubscriptions = [service.onDidChangeSession(session => this.onSessionChanged(session))];
		this.chat.setService(service);
		this.agents.setService(service);
		this.changes.setService(service);
		this.interactions.setService(service);
		this.presentations.setService(service);
		this.statusBar.setService(service);
		return true;
	}

	private markUnavailable(message: string): void {
		this.logger.error(`OMP not found: ${message}`);
		this.chat.setUnavailable(message);
		this.statusBar.setUnavailable(message);
		this.agentsView.message = "OMP not found. Set omp.executablePath and run OMP: Restart.";
		this.changesView.message = "OMP not found.";
		void vscode.window.showErrorMessage(`oh-my-pi: ${message}`, "Open Settings").then(choice => {
			if (choice === "Open Settings") return openOmpSettings();
		});
	}

	private onSessionChanged(session: SessionView): void {
		void this.setContext("omp.busy", session.phase !== "idle");
		void this.setContext("omp.hasThinkingLevels", session.availableThinkingLevels.length > 0);
		if (session.sessionFile && session.sessionFile !== this.context.workspaceState.get<string>(LAST_SESSION_KEY)) {
			this.context.workspaceState.update(LAST_SESSION_KEY, session.sessionFile).then(undefined, error =>
				this.logger.error("Failed to persist last session file", error),
			);
		}
	}

	private setContext(key: string, value: unknown): Thenable<unknown> {
		return vscode.commands.executeCommand("setContext", key, value);
	}

	private needsStart(): boolean {
		const state = this.service?.connection.state;
		return !this.starting && (state === "stopped" || state === "failed");
	}

	private startInBackground(options: StartOptions | undefined): void {
		this.start(options).catch(async error => {
			this.logger.error("OMP failed to start", error);
			const choice = await vscode.window.showErrorMessage(`OMP failed to start: ${errorMessage(error)}`, "Show Log", "Open Settings");
			if (choice === "Show Log") this.output.show(true);
			else if (choice === "Open Settings") await openOmpSettings();
		});
	}

	private start(options: StartOptions | undefined): Promise<void> {
		const service = this.service;
		if (!service) return Promise.reject(new Error("OMP is not available"));
		const starting = service.start(options).finally(() => {
			if (this.starting === starting) this.starting = undefined;
		});
		this.starting = starting;
		return starting;
	}

	async ensureService(options?: StartOptions): Promise<OmpServiceApi> {
		const service = this.service;
		if (!service) throw new Error("OMP executable not found. Configure omp.executablePath, then run OMP: Restart.");
		if (this.needsStart()) await this.start(options);
		else if (this.starting) await this.starting;
		return service;
	}

	async restart(): Promise<void> {
		const service = this.service;
		if (!service) {
			if (this.createService()) this.startInBackground(this.resumeOptions());
			return;
		}
		if (this.needsStart()) {
			await this.ensureService(this.resumeOptions());
			return;
		}
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Restarting OMP" }, () => service.restart());
	}

	/** Rebuilds the service with fresh settings, keeping the current session. */
	private async recreate(): Promise<void> {
		const sessionFile = this.service?.session.sessionFile;
		await this.stopService();
		if (!this.createService()) return;
		this.startInBackground(sessionFile && fs.existsSync(sessionFile) ? { resumeSessionFile: sessionFile } : this.resumeOptions());
	}

	private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
		if (!RESTART_SETTINGS.some(setting => event.affectsConfiguration(setting))) return;
		void vscode.window.showInformationMessage("OMP settings changed. Restart OMP to apply them?", "Restart").then(async choice => {
			if (choice !== "Restart") return;
			try {
				await this.recreate();
			} catch (error) {
				this.logger.error("OMP restart after settings change failed", error);
				void vscode.window.showErrorMessage(`OMP restart failed: ${errorMessage(error)}`);
			}
		});
	}

	private async openFile(rawPath: string, line?: number): Promise<void> {
		const filePath = resolveToolPath(rawPath, this.service?.cwd ?? workingDirectory());
		if (!filePath) {
			void vscode.window.showWarningMessage(`Not a local file: ${rawPath}`);
			return;
		}
		const position = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
		await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
			preview: true,
			selection: position && new vscode.Range(position, position),
		});
	}

	private async openToolDiff(toolCallId: string): Promise<void> {
		const item = this.service?.transcript.find(candidate => candidate.id === toolCallId);
		if (item?.kind !== "tool") {
			void vscode.window.showWarningMessage("That tool call is no longer in the transcript.");
			return;
		}
		await this.changes.whenIdle();
		if (!(await this.changes.openToolDiff(item))) void vscode.window.showInformationMessage("No diff recorded for this tool call.");
	}

	private async stopService(): Promise<void> {
		const service = this.service;
		this.service = undefined;
		this.starting = undefined;
		this.serviceSubscriptions.forEach(subscription => subscription.dispose());
		this.serviceSubscriptions = [];
		if (!service) return;
		this.chat.setService(undefined);
		this.agents.setService(undefined);
		this.changes.setService(undefined);
		this.interactions.setService(undefined);
		this.presentations.setService(undefined);
		this.statusBar.setService(undefined);
		try {
			await service.stop();
		} finally {
			service.dispose();
		}
	}

	stop(): Promise<void> {
		return this.stopService();
	}

	dispose(): void {
		const service = this.service;
		this.service = undefined;
		this.serviceSubscriptions.forEach(subscription => subscription.dispose());
		service?.dispose();
		this.disposables.forEach(disposable => disposable.dispose());
	}
}

let host: OmpHost | undefined;

export function activate(context: vscode.ExtensionContext): OmpExtensionApi {
	const output = vscode.window.createOutputChannel("oh-my-pi");
	const logger = new OutputLogger(output);
	const created = new OmpHost(context, output, logger);
	host = created;
	context.subscriptions.push(output, created);
	created.initialize();
	return created.api;
}

export function deactivate(): Promise<void> | undefined {
	const current = host;
	host = undefined;
	return current?.stop();
}
