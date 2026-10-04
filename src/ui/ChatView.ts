import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ConnectionStatus, Disposable, Logger, OmpServiceApi, PromptMode, PromptOutcome, SessionView, TranscriptItem } from "../omp/api";
import { editorContextBlock } from "../vscode/EditorContext";
import type { Attachment, HostMessage, PendingInteraction, RenderedReport, WebviewMessage } from "../webview/protocol";
import { pickContextFiles } from "./contextPicker";
import { errorMessage } from "./guards";
import type { InteractionSurface } from "./interactions";
import { composePrompt } from "./promptComposer";

const ITEM_COALESCE_MS = 30;

const EMPTY_SESSION: SessionView = {
	phase: "idle",
	availableThinkingLevels: [],
	isStreaming: false,
	isCompacting: false,
	queue: { steering: [], followUp: [] },
	todos: [],
};

/** What the chat view needs from the extension host. */
export interface ChatHost {
	/** The running service; starts OMP first when startup is `manual`. Rejects when OMP is unavailable. */
	ensureService(): Promise<OmpServiceApi>;
	pendingInteractions(): PendingInteraction[];
	respond(id: string, response: Extract<WebviewMessage, { type: "respond" }>["response"]): void;
	openFile(filePath: string, line?: number): Promise<void>;
	openToolDiff(toolCallId: string): Promise<void>;
}

/** The OMP chat: a webview view in the Secondary Sidebar (Activity Bar on VS Code < 1.106). */
export class ChatView implements vscode.WebviewViewProvider, InteractionSurface, vscode.Disposable {
	/** Latest render report posted by the webview (integration-test hook). */
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

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly viewId: string,
		private readonly logger: Logger,
		private readonly host: ChatHost,
	) {}

	get visible(): boolean {
		return this.view?.visible === true;
	}

	setService(service: OmpServiceApi | undefined): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.service = service;
		this.unavailable = undefined;
		this.subscriptions = service
			? [
					service.onDidChangeTranscriptItem(item => {
						this.pendingItems.set(item.id, item);
						this.scheduleFlush();
					}),
					service.onDidResetTranscript(() => this.postReset()),
					service.onDidChangeSession(session => {
						this.pendingSession = session;
						this.scheduleFlush();
					}),
					service.onDidChangeConnection(connection => this.post({ type: "connection", connection })),
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

	notice(level: "info" | "warning" | "error", text: string): void {
		this.post({ type: "notice", level, text });
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
		this.view.webview.postMessage(message).then(undefined, error => this.logger.debug(`postMessage failed: ${String(error)}`));
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => this.flush(), ITEM_COALESCE_MS);
	}

	private flush(): void {
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
			session: this.service?.session ?? EMPTY_SESSION,
			connection,
			interactions: this.host.pendingInteractions(),
			includeEditorContext: vscode.workspace.getConfiguration("omp").get<boolean>("includeEditorContext", true),
			unavailable: this.unavailable,
			cwd: this.service?.cwd,
		});
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
				return;
			}
			case "rendered": {
				const { counts, lastAssistantText, interactions, collapsedTools, attachments } = message;
				this.lastRendered = { counts, lastAssistantText, interactions, collapsedTools, attachments };
				this.renderEmitter.fire(this.lastRendered);
				return;
			}
			case "send":
				await this.guard("Prompt", async () => {
					await this.send(message.text, message.mode, message.includeContext, message.attachments);
				});
				return;
			case "pickContext":
				this.addFiles(await pickContextFiles());
				return;
			case "abort":
				await this.guard("Abort", async service => service.abort());
				return;
			case "command":
				await vscode.commands.executeCommand(message.command);
				return;
			case "setThinkingLevel":
				await this.guard("Set thinking level", async service => service.setThinkingLevel(message.level));
				return;
			case "openFile":
				await this.host.openFile(message.path, message.line);
				return;
			case "openDiff":
				if (message.toolCallId) await this.host.openToolDiff(message.toolCallId);
				else if (message.path) await this.host.openFile(message.path);
				return;
			case "showAgents":
				await vscode.commands.executeCommand("omp.showAgents");
				return;
			case "respond":
				this.host.respond(message.id, message.response);
				return;
		}
	}

	private async guard(action: string, run: (service: OmpServiceApi) => Promise<void>): Promise<void> {
		try {
			await run(await this.host.ensureService());
		} catch (error) {
			const text = `${action} failed: ${errorMessage(error)}`;
			this.logger.error(action, error);
			if (this.visible) this.notice("error", text);
			else void vscode.window.showErrorMessage(`OMP: ${text}`);
		}
	}

	/** Sends user text with its attachments and the optional editor context; resolves at prompt completion. */
	async send(text: string, mode: PromptMode, includeContext: boolean, attachments: readonly Attachment[] = []): Promise<PromptOutcome> {
		const service = await this.host.ensureService();
		const { message, images } = composePrompt({
			text,
			attachments,
			cwd: service.cwd,
			editorContext: includeContext ? editorContextBlock(this.logger) : undefined,
		});
		const outcome = await service.prompt(message, mode, images);
		if (outcome.status === "error") this.logger.warn(`Prompt ended with error: ${outcome.error ?? "unknown error"}`);
		return outcome;
	}

	dispose(): void {
		clearTimeout(this.flushTimer);
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.viewSubscriptions.forEach(subscription => subscription.dispose());
		this.renderEmitter.dispose();
	}
}
