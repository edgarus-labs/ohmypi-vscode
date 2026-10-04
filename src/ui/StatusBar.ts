import * as vscode from "vscode";
import type { Disposable, OmpServiceApi } from "../omp/api";

/** `OMP: <model> · <phase>`; click opens the conversation panel. */
export class OmpStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem("omp.status", vscode.StatusBarAlignment.Left, 100);
	private subscriptions: Disposable[] = [];
	private service: OmpServiceApi | undefined;
	private unavailable: string | undefined;

	constructor() {
		this.item.name = "OMP";
		this.item.command = "omp.openConversation";
		this.render();
		this.item.show();
	}

	setService(service: OmpServiceApi | undefined): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.service = service;
		this.unavailable = undefined;
		this.subscriptions = service ? [service.onDidChangeSession(() => this.render()), service.onDidChangeConnection(() => this.render())] : [];
		this.render();
	}

	setUnavailable(message: string): void {
		this.setService(undefined);
		this.unavailable = message;
		this.render();
	}

	private render(): void {
		const service = this.service;
		if (!service) {
			this.item.text = this.unavailable ? "$(error) OMP: not found" : "OMP: stopped";
			this.item.tooltip = this.unavailable ?? "OMP is not running";
			return;
		}
		const { connection, session } = service;
		const state = connection.state === "ready" ? session.phase : connection.state;
		const busy = connection.state === "ready" && session.phase !== "idle";
		this.item.text = `${busy ? "$(sync~spin) " : ""}OMP: ${session.model?.name ?? "no model"} · ${state}`;
		this.item.tooltip = [
			`connection: ${connection.state}${connection.detail ? ` (${connection.detail})` : ""}`,
			session.sessionName ?? session.sessionId,
			session.model && `${session.model.provider}/${session.model.id}`,
		]
			.filter(Boolean)
			.join("\n");
	}

	dispose(): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.item.dispose();
	}
}
