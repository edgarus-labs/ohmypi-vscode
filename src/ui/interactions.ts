import * as vscode from "vscode";
import type { Disposable, InteractionRequest, InteractionResponse, Logger, OmpServiceApi, PresentationRequest } from "../omp/api";
import { errorMessage } from "../shared/errors";
import { statusDisplayText } from "../shared/router";
import type { PendingInteraction } from "../webview/protocol";

/** The conversation panel as seen by interaction/presentation handling. */
export interface InteractionSurface {
	readonly visible: boolean;
	showInteraction(pending: PendingInteraction): void;
	closeInteraction(id: string): void;
	setComposerText(text: string): void;
	reveal(): Promise<void>;
}

interface Entry {
	pending: PendingInteraction;
	native?: vscode.CancellationTokenSource;
}

function interactionTitle(request: InteractionRequest): string {
	return request.kind === "ask" ? (request.questions[0]?.question ?? "Question") : request.title;
}

/**
 * Routes OMP dialogs to the inline conversation UI and, when the conversation is not visible, to a
 * native notification with an optional QuickPick/InputBox fallback. The first answer wins.
 * Nothing is ever answered automatically.
 */
export class InteractionController implements vscode.Disposable {
	private readonly entries = new Map<string, Entry>();
	private service: OmpServiceApi | undefined;
	private subscriptions: Disposable[] = [];

	constructor(
		private readonly surface: InteractionSurface,
		private readonly logger: Logger,
	) {}

	setService(service: OmpServiceApi | undefined): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		for (const id of [...this.entries.keys()]) this.close(id);
		this.service = service;
		this.subscriptions = service
			? [service.onInteractionRequest(request => this.add(request)), service.onInteractionCancelled(id => this.cancelled(id))]
			: [];
	}

	list(): PendingInteraction[] {
		return [...this.entries.values()].map(entry => entry.pending);
	}

	respond(id: string, response: InteractionResponse): void {
		const entry = this.entries.get(id);
		if (!entry || !this.service) {
			this.logger.debug(`Ignoring answer for interaction ${id}: no longer pending`);
			return;
		}
		try {
			this.service.respondInteraction(id, response);
		} catch (error) {
			this.logger.error(`Failed to answer interaction ${id}`, error);
			void vscode.window.showErrorMessage(`OMP: failed to send your answer: ${errorMessage(error)}`);
			return;
		}
		this.close(id);
		this.logger.info(`Interaction ${id} (${entry.pending.request.kind}) answered: ${response.kind}`);
	}

	private add(request: InteractionRequest): void {
		const timeoutMs = "timeoutMs" in request ? request.timeoutMs : undefined;
		const pending: PendingInteraction = timeoutMs ? { request, expiresAt: Date.now() + timeoutMs } : { request };
		this.entries.set(request.id, { pending });
		this.logger.info(`Interaction ${request.id} (${request.kind}) requested`);
		this.surface.showInteraction(pending);
		if (!this.surface.visible) {
			this.notifyNatively(request).catch(error => this.logger.error(`Native notification for interaction ${request.id} failed`, error));
		}
	}

	private cancelled(id: string): void {
		if (!this.entries.has(id)) return;
		this.logger.info(`Interaction ${id} withdrawn by OMP`);
		this.close(id);
	}

	private close(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		this.entries.delete(id);
		entry.native?.cancel();
		this.surface.closeInteraction(id);
	}

	private async notifyNatively(request: InteractionRequest): Promise<void> {
		const canAnswerHere = request.kind === "confirm" || request.kind === "select" || request.kind === "input";
		const actions = canAnswerHere ? ["Show", "Answer here"] : ["Show"];
		const choice = await vscode.window.showInformationMessage(`OMP needs your input: ${interactionTitle(request)}`, ...actions);
		if (!this.entries.has(request.id)) return;
		if (choice === "Show") await this.surface.reveal();
		else if (choice === "Answer here") await this.answerNatively(request);
	}

	private async answerNatively(request: InteractionRequest): Promise<void> {
		const entry = this.entries.get(request.id);
		if (!entry) return;
		const source = new vscode.CancellationTokenSource();
		entry.native = source;
		try {
			const response = await this.askNative(request, source.token);
			if (response && !source.token.isCancellationRequested) this.respond(request.id, response);
		} finally {
			source.dispose();
			if (entry.native === source) entry.native = undefined;
		}
	}

	private async askNative(request: InteractionRequest, token: vscode.CancellationToken): Promise<InteractionResponse | undefined> {
		switch (request.kind) {
			case "confirm": {
				const pick = await vscode.window.showQuickPick(
					[{ label: "Approve" }, { label: "Deny" }],
					{ title: request.title, placeHolder: request.message ?? request.title, ignoreFocusOut: true },
					token,
				);
				return pick && { kind: "confirmed", confirmed: pick.label === "Approve" };
			}
			case "select": {
				const pick = await vscode.window.showQuickPick(
					request.options.map(option => ({ label: option.label, detail: option.description })),
					{ title: request.title, placeHolder: request.title, ignoreFocusOut: true },
					token,
				);
				return pick && { kind: "value", value: pick.label };
			}
			case "input": {
				const value = await vscode.window.showInputBox(
					{ title: request.title, prompt: request.title, placeHolder: request.placeholder, ignoreFocusOut: true },
					token,
				);
				return value === undefined ? undefined : { kind: "value", value };
			}
			default:
				return undefined;
		}
	}

	dispose(): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		for (const entry of this.entries.values()) entry.native?.cancel();
		this.entries.clear();
	}
}

/** Fire-and-forget presentation requests (notify, status, openUrl, editorText). */
export class PresentationHandler implements vscode.Disposable {
	private readonly statusItems = new Map<string, vscode.StatusBarItem>();
	private subscriptions: Disposable[] = [];

	constructor(
		private readonly surface: InteractionSurface,
		private readonly logger: Logger,
	) {}

	/** Status items belong to one OMP process: they go when the service changes or its process stops. */
	setService(service: OmpServiceApi | undefined): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.clearStatusItems();
		this.subscriptions = service
			? [
					service.onPresentation(request => {
						this.handle(request).catch(error => this.logger.error(`Presentation ${request.kind} failed`, error));
					}),
					service.onDidChangeConnection(status => {
						if (status.state !== "ready") this.clearStatusItems();
					}),
				]
			: [];
	}

	private async handle(request: PresentationRequest): Promise<void> {
		switch (request.kind) {
			case "notify": {
				const show =
					request.level === "error"
						? vscode.window.showErrorMessage
						: request.level === "warning"
							? vscode.window.showWarningMessage
							: vscode.window.showInformationMessage;
				void show(`OMP: ${request.message}`);
				return;
			}
			case "status": {
				let item = this.statusItems.get(request.key);
				if (!request.text) {
					item?.dispose();
					this.statusItems.delete(request.key);
					return;
				}
				if (!item) {
					item = vscode.window.createStatusBarItem(`omp.status.${request.key}`, vscode.StatusBarAlignment.Left, 90);
					item.name = `OMP ${request.key}`;
					this.statusItems.set(request.key, item);
				}
				item.text = statusDisplayText(request.key, request.text);
				item.tooltip = item.text === request.text ? `OMP: ${request.key}` : `OMP: ${request.key}\n${request.text}`;
				item.show();
				return;
			}
			case "openUrl": {
				const uri = vscode.Uri.parse(request.url);
				if (uri.scheme !== "https" && uri.scheme !== "http") {
					void vscode.window.showWarningMessage(`OMP asked to open a non-web URL; ignored: ${request.url}`);
					return;
				}
				const detail = request.instructions ? `${request.instructions}\n\n${request.url}` : request.url;
				const choice = await vscode.window.showInformationMessage("OMP wants to open a URL in your browser.", { modal: true, detail }, "Open");
				if (choice === "Open") await vscode.env.openExternal(uri);
				return;
			}
			case "editorText":
				this.surface.setComposerText(request.text);
				return;
		}
	}

	private clearStatusItems(): void {
		for (const item of this.statusItems.values()) item.dispose();
		this.statusItems.clear();
	}

	dispose(): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.clearStatusItems();
	}
}
