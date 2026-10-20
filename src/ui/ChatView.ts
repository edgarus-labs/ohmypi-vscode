import * as crypto from "node:crypto";
import * as path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import * as vscode from "vscode";
import type {
	ConnectionStatus,
	Disposable,
	Logger,
	OmpServiceApi,
	PromptMode,
	PromptOutcome,
	SessionView,
	SlashCommandView,
	TranscriptItem,
} from "../omp/api";
import { errorMessage } from "../shared/errors";
import { emptySessionView } from "../shared/session";
import { editorContextBlock } from "../vscode/EditorContext";
import {
	type Attachment,
	type HostMessage,
	isWebviewCommand,
	type PendingInteraction,
	type RecentSession,
	type RenderedReport,
	type StatusEntry,
	type WebviewMessage,
} from "../webview/protocol";
import { pickContextFiles } from "./contextPicker";
import type { InteractionSurface } from "./interactions";
import { composePrompt } from "./promptComposer";
import { recentSessions } from "./recentSessions";

const ITEM_COALESCE_MS = 30;
/** Todo dismissal keys are short content hashes; anything longer is not one. */
const MAX_DISMISSAL_KEY_LENGTH = 100;

/**
 * Whether OMP runs `text` as a slash command: its first token names a listed command or alias,
 * or is any `/word` while OMP has not listed its commands yet. OMP recognizes a command only at
 * the very start of the prompt.
 */
function isSlashCommand(text: string, commands: readonly SlashCommandView[]): boolean {
	const name = /^\/(\S+)/.exec(text)?.[1];
	if (name === undefined) return false;
	return commands.length === 0 || commands.some(command => command.name === name || command.aliases.includes(name));
}

const EXTERNAL_SCHEMES = ["http:", "https:", "mailto:"];

/** The URI of a web (`http`/`https` with a host) or `mailto` link; `undefined` for anything else. */
function externalLink(url: unknown): vscode.Uri | undefined {
	if (typeof url !== "string") return undefined;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (!EXTERNAL_SCHEMES.includes(parsed.protocol) || (parsed.protocol !== "mailto:" && !parsed.hostname)) return undefined;
	return vscode.Uri.parse(url);
}

/** What the chat view needs from the extension host. */
export interface ChatHost {
	/** The running service; starts OMP first when startup is `manual`. Rejects when OMP is unavailable. */
	ensureService(): Promise<OmpServiceApi>;
	pendingInteractions(): PendingInteraction[];
	respond(id: string, response: Extract<WebviewMessage, { type: "respond" }>["response"]): void;
	openFile(filePath: string, line?: number): Promise<void>;
	/** `file`: one of the call's files, as the call names it. */
	openToolDiff(toolCallId: string, file?: string): Promise<void>;
	/** Keys of the todo lists the user closed, newest first. */
	dismissedTodos(): readonly string[];
	/** Remembers that the user closed the todo list whose content gives `key`. */
	dismissTodos(key: string): Promise<void>;
}

/** The OMP chat: a webview view in the Secondary Sidebar (Activity Bar on VS Code < 1.106). */
export class ChatView implements vscode.WebviewViewProvider, InteractionSurface, vscode.Disposable {
	/** Latest render report posted by the webview (integration-test hook; only with test hooks on). */
	lastRendered: RenderedReport | undefined;
	private readonly renderEmitter = new vscode.EventEmitter<RenderedReport>();
	readonly onDidRender = this.renderEmitter.event;

	private view: vscode.WebviewView | undefined;
	private service: OmpServiceApi | undefined;
	private unavailable: string | undefined;
	private subscriptions: Disposable[] = [];
	private viewSubscriptions: vscode.Disposable[] = [];
	private readonly pendingItems = new Map<string, TranscriptItem>();
	private pendingSession: SessionView | undefined;
	private flushTimer: NodeJS.Timeout | undefined;
	/** Set by the webview's `ready` message; nothing is posted before it. */
	private webviewReady = false;
	/** Composer requests that arrived before the webview was ready; applied right after the reset. */
	private pendingComposer: { text?: string; focus: boolean } | undefined;
	/** Files added before the webview was ready; posted right after the reset. */
	private pendingAttachments: Attachment[] = [];
	/** Notices raised before the webview was ready; posted right after the reset. */
	private pendingNotices: Array<Extract<HostMessage, { type: "notice" }>> = [];
	/** Recent sessions last posted to the webview; `openSession` accepts only these. */
	private offered: readonly RecentSession[] = [];
	/** Session file the recent sessions were last listed for. */
	private offeredFor: string | undefined;
	/** Increments per listing so a slower, older listing never overwrites a newer one. */
	private listing = 0;
	/** `OMP: Show Usage` ran before the webview was ready; toggled right after the reset. */
	private pendingUsageToggle = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly viewId: string,
		private readonly logger: Logger,
		private readonly host: ChatHost,
		/** Lets the webview post `rendered` reports (extension tests only). */
		private readonly testHooks: boolean,
	) {}

	get visible(): boolean {
		return this.view?.visible === true;
	}

	/** Recent sessions last posted to the webview (integration-test hook). */
	get offeredSessions(): readonly RecentSession[] {
		return this.offered;
	}

	setService(service: OmpServiceApi | undefined): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.service = service;
		this.unavailable = undefined;
		this.subscriptions = service
			? [
					service.onDidChangeTranscriptItem(item => {
						this.pendingItems.set(item.id, item);
						if (item.kind === "user" && item.pending) this.flush();
						else this.scheduleFlush();
					}),
					service.onDidResetTranscript(() => this.postReset()),
					service.onDidChangeSession(session => {
						this.pendingSession = session;
						this.scheduleFlush();
						if (session.sessionFile !== this.offeredFor) this.refreshRecentSessions();
					}),
					service.onDidChangeConnection(connection => this.post({ type: "connection", connection })),
					service.onPresentation(request => request.kind === "status" && this.post({ type: "statuses", statuses: this.statusEntries() })),
				]
			: [];
		this.postReset();
	}

	/** Puts the chat into the "OMP not available" state. */
	setUnavailable(message: string): void {
		this.setService(undefined);
		this.unavailable = message;
		this.postReset();
	}

	showInteraction(pending: PendingInteraction): void {
		this.post({ type: "interaction", pending });
	}

	closeInteraction(id: string): void {
		this.post({ type: "interactionClosed", id });
	}

	setComposerText(text: string): void {
		if (this.webviewReady) this.post({ type: "setComposer", text });
		else this.pendingComposer = { text, focus: true };
	}

	focusComposer(): void {
		if (this.webviewReady) this.post({ type: "focusComposer" });
		else this.pendingComposer = { ...this.pendingComposer, focus: true };
	}

	/** Opens the usage popup over the transcript, or closes it when it is open. */
	toggleUsage(): void {
		if (this.webviewReady) this.post({ type: "toggleUsage" });
		else this.pendingUsageToggle = !this.pendingUsageToggle;
	}

	notice(level: "info" | "warning" | "error", text: string): void {
		if (this.webviewReady) this.post({ type: "notice", level, text });
		else this.pendingNotices.push({ type: "notice", level, text });
	}

	/** Adds files or folders as chips above the input; OMP reads them via `@path` mentions on send. */
	addFiles(uris: readonly vscode.Uri[]): void {
		const attachments: Attachment[] = uris
			.filter(uri => uri.scheme === "file")
			.map(uri => ({ id: crypto.randomUUID(), kind: "file", path: uri.fsPath, label: path.basename(uri.fsPath) }));
		if (attachments.length === 0) return;
		if (this.webviewReady) this.post({ type: "addAttachments", attachments });
		else this.pendingAttachments.push(...attachments);
	}

	/** Opens the side bar holding the chat and shows the view. */
	async reveal(options: { preserveFocus?: boolean } = {}): Promise<void> {
		if (this.view) {
			this.view.show(options.preserveFocus);
			return;
		}
		await vscode.commands.executeCommand(`${this.viewId}.focus`);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.viewSubscriptions.forEach(subscription => subscription.dispose());
		this.view = view;
		this.webviewReady = false;
		const webview = view.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist"), vscode.Uri.joinPath(this.extensionUri, "media")],
		};
		webview.html = this.html(webview);
		this.viewSubscriptions = [
			webview.onDidReceiveMessage((message: WebviewMessage) => {
				this.onMessage(message).catch(error => this.logger.error(`Chat message ${message.type} failed`, error));
			}),
			view.onDidDispose(() => {
				if (this.view !== view) return;
				this.view = undefined;
				this.webviewReady = false;
			}),
		];
	}

	private html(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString("base64");
		const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "chat.css"));
		const csp = [
			"default-src 'none'",
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
			`img-src ${webview.cspSource} data:`,
			`font-src ${webview.cspSource}`,
		].join("; ");
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>OMP</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}

	private post(message: HostMessage): void {
		if (!this.view || !this.webviewReady) return;
		this.view.webview.postMessage(message).then(undefined, error => this.logger.debug("postMessage failed", error));
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => this.flush(), ITEM_COALESCE_MS);
	}

	private flush(): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.pendingSession) this.post({ type: "session", session: this.pendingSession });
		for (const item of this.pendingItems.values()) this.post({ type: "item", item });
		this.pendingSession = undefined;
		this.pendingItems.clear();
	}

	private postReset(): void {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		this.pendingItems.clear();
		this.pendingSession = undefined;
		const connection: ConnectionStatus = this.service?.connection ?? { state: "stopped" };
		this.post({
			type: "reset",
			items: [...(this.service?.transcript ?? [])],
			session: this.service?.session ?? emptySessionView(),
			connection,
			interactions: this.host.pendingInteractions(),
			includeEditorContext: vscode.workspace.getConfiguration("omp").get<boolean>("includeEditorContext", true),
			unavailable: this.unavailable,
			cwd: this.service?.cwd,
			testHooks: this.testHooks,
			statuses: this.statusEntries(),
			dismissedTodos: [...this.host.dismissedTodos()],
		});
		this.refreshRecentSessions();
	}

	private statusEntries(): StatusEntry[] {
		return [...(this.service?.statuses ?? [])].map(([key, text]) => ({ key, text }));
	}

	private refreshRecentSessions(): void {
		if (!this.view || !this.webviewReady) return;
		const service = this.service;
		const currentFile = service?.session.sessionFile;
		const listing = ++this.listing;
		this.offeredFor = currentFile;
		(service ? service.listSessions() : Promise.resolve([])).then(
			summaries => {
				if (listing !== this.listing) return;
				const { sessions, total } = recentSessions(summaries, currentFile);
				this.offered = sessions;
				this.post({ type: "recentSessions", sessions, total });
			},
			error => this.logger.error("Listing recent sessions failed", error),
		);
	}

	private async onMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "ready": {
				this.webviewReady = true;
				this.postReset();
				const composer = this.pendingComposer;
				this.pendingComposer = undefined;
				if (composer?.text !== undefined) this.post({ type: "setComposer", text: composer.text });
				else if (composer?.focus) this.post({ type: "focusComposer" });
				if (this.pendingAttachments.length > 0) this.post({ type: "addAttachments", attachments: this.pendingAttachments.splice(0) });
				for (const notice of this.pendingNotices.splice(0)) this.post(notice);
				if (this.pendingUsageToggle) this.post({ type: "toggleUsage" });
				this.pendingUsageToggle = false;
				return;
			}
			case "rendered": {
				if (!this.testHooks) return;
				const { counts, lastAssistantText, interactions, collapsedTools, attachments, recentSessions } = message;
				this.lastRendered = { counts, lastAssistantText, interactions, collapsedTools, attachments, recentSessions };
				this.renderEmitter.fire(this.lastRendered);
				return;
			}
			case "send":
				await this.submit(message);
				return;
			case "pickContext":
				this.addFiles(await pickContextFiles(this.logger));
				return;
			case "abort":
				await this.guard("Abort", async service => service.abort());
				return;
			case "command": {
				const command: unknown = message.command;
				if (!isWebviewCommand(command)) {
					this.logger.warn(`Ignoring a command the chat may not run: ${String(command)}`);
					return;
				}
				await vscode.commands.executeCommand(command);
				return;
			}
			case "setThinkingLevel":
				await this.guard("Set thinking level", async service => service.setThinkingLevel(message.level));
				return;
			case "openFile":
				await this.attempt("Open file", () => this.host.openFile(message.path, message.line));
				return;
			case "openDiff": {
				const file: unknown = message.path;
				if (file !== undefined && (typeof file !== "string" || !file)) {
					this.logger.warn(`Ignoring a tool diff for a file that is not a path: ${String(file)}`);
					return;
				}
				await this.attempt("Open diff", () => this.host.openToolDiff(message.toolCallId, file));
				return;
			}
			case "openExternal": {
				const link = externalLink(message.url);
				if (!link) {
					this.logger.warn(`Not opening a link that is not a web or mail link: ${String(message.url)}`);
					return;
				}
				await this.attempt("Open link", async () => {
					await vscode.env.openExternal(link);
				});
				return;
			}
			case "showAgents":
				await vscode.commands.executeCommand("omp.showAgents");
				return;
			case "respond":
				this.host.respond(message.id, message.response);
				return;
			case "openSession": {
				const file: unknown = message.path;
				if (typeof file !== "string" || !this.offered.some(session => session.path === file)) {
					this.logger.warn(`Ignoring openSession for a session that was not offered: ${String(file)}`);
					return;
				}
				await this.guard("Open session", async service => {
					if (file !== service.session.sessionFile) await service.switchSession(file);
				});
				return;
			}
			case "resumeTierRouter":
				await this.attempt("Resume tier router", async () => {
					await this.send("/tier-auto", "auto", false);
				});
				return;
			case "loadUsage": {
				const id: unknown = message.id;
				if (typeof id !== "string") {
					this.logger.warn(`Ignoring a usage request without an id: ${String(id)}`);
					return;
				}
				try {
					const service = await this.host.ensureService();
					this.post({ type: "usage", id, providers: await service.getUsage() });
				} catch (error) {
					this.logger.error("Loading usage from OMP failed", error);
					this.post({ type: "usage", id, error: errorMessage(error) });
				}
				return;
			}
			case "dismissTodos": {
				const key: unknown = message.key;
				if (typeof key !== "string" || key === "" || key.length > MAX_DISMISSAL_KEY_LENGTH) {
					this.logger.warn(`Ignoring a todo dismissal with an invalid key: ${String(key)}`);
					return;
				}
				await this.attempt("Hide todos", () => this.host.dismissTodos(key));
				return;
			}
		}
	}

	/** Answers the webview's `send` with `sendResult` once OMP accepted or refused the prompt; later failures become a notice. */
	private async submit(message: Extract<WebviewMessage, { type: "send" }>): Promise<void> {
		let accepted = false;
		try {
			await this.send(message.text, message.mode, message.includeContext, message.attachments, () => {
				accepted = true;
				this.post({ type: "sendResult", id: message.id, ok: true });
			});
		} catch (error) {
			if (accepted) {
				this.report("Prompt", error);
				return;
			}
			this.logger.error("Prompt", error);
			this.post({ type: "sendResult", id: message.id, ok: false, error: errorMessage(error) });
		}
	}

	private guard(action: string, run: (service: OmpServiceApi) => Promise<void>): Promise<void> {
		return this.attempt(action, async () => run(await this.host.ensureService()));
	}

	private async attempt(action: string, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			this.report(action, error);
		}
	}

	/** Logs a failed user action and shows it in the chat, or natively while the chat is hidden. */
	private report(action: string, error: unknown): void {
		const text = `${action} failed: ${errorMessage(error)}`;
		this.logger.error(action, error);
		if (this.visible) this.notice("error", text);
		else void vscode.window.showErrorMessage(`OMP: ${text}`);
	}

	/**
	 * Sends user text with its attachments and the optional editor context; resolves at prompt completion.
	 * While the agent is idle the text shows in the chat at once as a pending message, before OMP is
	 * started or the editor context is gathered. A slash command goes without the editor context, which
	 * would otherwise come first and hide the command from OMP.
	 * `onAccepted` runs once OMP took the prompt; when OMP cannot take it (not running, start failed)
	 * this rejects without calling it and the pending message is removed.
	 */
	async send(
		text: string,
		mode: PromptMode,
		includeContext: boolean,
		attachments: readonly Attachment[] = [],
		onAccepted?: () => void,
	): Promise<PromptOutcome> {
		const shown = this.showPending(text, attachments);
		let outcome: Promise<PromptOutcome>;
		try {
			const service = await this.host.ensureService();
			const withContext = includeContext && !isSlashCommand(text, service.session.commands);
			const { message, images } = composePrompt({
				text,
				attachments,
				cwd: service.cwd,
				editorContext: withContext ? editorContextBlock(this.logger) : undefined,
			});
			outcome = service.prompt(message, mode, images, shown?.service === service ? shown.id : undefined);
		} catch (error) {
			shown?.service.discardPendingPrompt(shown.id);
			throw error;
		}
		// A refused prompt rejects at once; one macrotask turn tells that apart from a prompt in progress.
		await Promise.race([outcome, nextTurn()]);
		onAccepted?.();
		const result = await outcome;
		if (result.status === "error") this.logger.warn(`Prompt ended with error: ${result.error ?? "unknown error"}`);
		return result;
	}

	/** Adds the prompt as a pending user message of the current service; nothing while the agent is busy or there is no service. */
	private showPending(text: string, attachments: readonly Attachment[]): { service: OmpServiceApi; id: string } | undefined {
		const service = this.service;
		if (!service) return undefined;
		const { message, images } = composePrompt({ text, attachments, cwd: service.cwd });
		const id = service.addPendingPrompt(message, images.length);
		return id === undefined ? undefined : { service, id };
	}

	dispose(): void {
		clearTimeout(this.flushTimer);
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.viewSubscriptions.forEach(subscription => subscription.dispose());
		this.renderEmitter.dispose();
	}
}
