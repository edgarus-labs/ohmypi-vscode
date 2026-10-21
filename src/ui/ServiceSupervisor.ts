import * as vscode from "vscode";
import type { ConnectionStatus, Disposable, Logger, OmpServiceApi, SessionBinding, SessionView } from "../omp/api";
import { isSupersededError } from "../omp/api";
import { deferred } from "../shared/deferred";
import { errorMessage } from "../shared/errors";
import { openOmpSettings } from "./commands";

/** A surface that follows the current service (`undefined` while there is none). */
export interface ServiceConsumer {
	setService(service: OmpServiceApi | undefined): void;
}

export interface ServiceSupervisorOptions {
	/** Builds a service from the current settings; throws when OMP cannot be used. */
	create(): OmpServiceApi;
	consumers: readonly ServiceConsumer[];
	/** Shows on every surface why there is no service. */
	showUnavailable(message: string): void;
	/** Session to bind when OMP starts without an explicit choice; `preferred` wins while its file exists. */
	resumeOptions(preferred?: string): SessionBinding | undefined;
	onSession(session: SessionView): void;
	logger: Logger;
	output: { show(preserveFocus?: boolean): void };
}

const RESTRICTED_MESSAGE = "OMP is disabled in Restricted Mode because it runs commands and edits files in this workspace. Trust the workspace to start OMP.";
const NOT_FOUND_MESSAGE = "OMP executable not found. Configure omp.executablePath, then run OMP: Restart.";

/**
 * Owns the OMP service: creation from settings, start, restart, recreation and teardown.
 * Restarts and recreations run one at a time; OMP never runs in an untrusted workspace.
 */
export class ServiceSupervisor implements vscode.Disposable {
	private current: OmpServiceApi | undefined;
	/** Start or restart of the current service requested here and not settled yet. */
	private starting: Promise<void> | undefined;
	/** Restart or recreation in progress; the next one waits for it. */
	private changing: Promise<void> | undefined;
	private subscriptions: Disposable[] = [];
	private readonly trustSubscription: vscode.Disposable;
	/** Set by `shutdown()`/`dispose()`; no service is created afterwards. */
	private disposed = false;

	constructor(private readonly options: ServiceSupervisorOptions) {
		void this.setContext("omp.busy", false);
		void this.setContext("omp.hasThinkingLevels", false);
		this.trustSubscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
			if (!this.current) this.initialize();
		});
	}

	get service(): OmpServiceApi | undefined {
		return this.current;
	}

	/** Creates the service and starts it according to `omp.startup`; without a workspace folder OMP waits for the first command. */
	initialize(): void {
		if (!this.createService()) return;
		if (!vscode.workspace.workspaceFolders?.length) {
			this.options.logger.info("No workspace folder is open: OMP starts on the first command");
			return;
		}
		const startup = vscode.workspace.getConfiguration("omp").get<string>("startup", "resumeLast");
		if (startup === "manual") {
			this.options.logger.info("Startup mode manual: OMP starts on the first command");
			return;
		}
		this.startInBackground(startup === "newSession" ? { newSession: true } : this.options.resumeOptions());
	}

	private createService(): boolean {
		if (this.disposed) return false;
		if (!vscode.workspace.isTrusted) {
			this.options.logger.info(RESTRICTED_MESSAGE);
			this.options.showUnavailable(RESTRICTED_MESSAGE);
			return false;
		}
		let service: OmpServiceApi;
		try {
			service = this.options.create();
		} catch (error) {
			this.markUnavailable(errorMessage(error));
			return false;
		}
		this.current = service;
		this.subscriptions = [
			service.onDidChangeSession(session => this.onSessionChanged(session)),
			service.onDidChangeConnection(status => this.onConnectionChanged(status)),
		];
		for (const consumer of this.options.consumers) consumer.setService(service);
		return true;
	}

	private markUnavailable(message: string): void {
		this.options.logger.error(`OMP not available: ${message}`);
		this.options.showUnavailable(message);
		void vscode.window.showErrorMessage(`oh-my-pi: ${message}`, "Open Settings").then(choice => {
			if (choice === "Open Settings") return openOmpSettings();
		});
	}

	private onSessionChanged(session: SessionView): void {
		void this.setContext("omp.busy", session.phase !== "idle");
		void this.setContext("omp.hasThinkingLevels", session.availableThinkingLevels.length > 0);
		this.options.onSession(session);
	}

	/** A start or restart requested here reports its own failure; any other failure means OMP stopped on its own. */
	private onConnectionChanged(status: ConnectionStatus): void {
		if (status.state !== "failed" || this.starting) return;
		void vscode.window.showErrorMessage(`OMP stopped: ${status.detail ?? "unknown reason"}`, "Restart", "Show Log").then(choice => {
			if (choice === "Restart") this.restart().catch(error => this.reportStartFailure(error));
			else if (choice === "Show Log") this.options.output.show(true);
		});
	}

	private setContext(key: string, value: unknown): Thenable<unknown> {
		return vscode.commands.executeCommand("setContext", key, value);
	}

	/** True when OMP has not been started (manual startup or after a failure). */
	needsStart(): boolean {
		const state = this.current?.connection.state;
		return !this.starting && (state === "stopped" || state === "failed");
	}

	private startInBackground(options: SessionBinding | undefined): void {
		this.start(options).catch(error => this.reportStartFailure(error));
	}

	private async reportStartFailure(error: unknown): Promise<void> {
		if (isSupersededError(error)) {
			this.options.logger.info("OMP start was superseded by a restart or stop");
			return;
		}
		this.options.logger.error("OMP failed to start", error);
		const choice = await vscode.window.showErrorMessage(`OMP failed to start: ${errorMessage(error)}`, "Show Log", "Open Settings");
		if (choice === "Show Log") this.options.output.show(true);
		else if (choice === "Open Settings") await openOmpSettings();
	}

	private start(options: SessionBinding | undefined): Promise<void> {
		const service = this.current;
		if (!service) return Promise.reject(new Error("OMP is not available"));
		return this.track(service.start(options));
	}

	private track(launch: Promise<void>): Promise<void> {
		const tracked = launch.finally(() => {
			if (this.starting === tracked) this.starting = undefined;
		});
		this.starting = tracked;
		return tracked;
	}

	/**
	 * The running service. Starts OMP when it is not running, with `options` or else the current (or last)
	 * session; waits for a restart, recreation or automatic restart in progress.
	 */
	async ensureService(options?: SessionBinding): Promise<OmpServiceApi> {
		for (;;) {
			const service = this.current;
			if (!service) {
				if (!this.changing) throw new Error(vscode.workspace.isTrusted ? NOT_FOUND_MESSAGE : RESTRICTED_MESSAGE);
				await this.changing.catch(() => undefined);
				continue;
			}
			if (!this.starting && service.connection.state === "restarting") {
				await this.restarted(service);
				continue;
			}
			const launch = this.needsStart() ? this.start(options ?? this.options.resumeOptions(service.session.sessionFile)) : this.starting;
			if (!launch) return service;
			try {
				await launch;
				return service;
			} catch (error) {
				if (!isSupersededError(error)) throw error;
				if (this.starting) continue;
				if (!this.changing) throw error;
				await this.changing.catch(() => undefined);
			}
		}
	}

	/** Resolves once an automatic restart of `service` is over, whichever way it ended. */
	private restarted(service: OmpServiceApi): Promise<void> {
		const done = deferred<void>();
		const subscription = service.onDidChangeConnection(status => {
			if (status.state === "restarting") return;
			subscription.dispose();
			done.resolve();
		});
		return done.promise;
	}

	/** Restarts OMP; a restart requested while one runs joins it. */
	restart(): Promise<void> {
		return this.changing ?? this.change(() => this.restartNow());
	}

	private async restartNow(): Promise<void> {
		const service = this.current;
		if (!service) {
			if (this.createService()) this.startInBackground(this.options.resumeOptions());
			return;
		}
		if (this.needsStart()) {
			await this.start(this.options.resumeOptions());
			return;
		}
		try {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Restarting OMP" }, () => this.track(service.restart()));
		} catch (error) {
			if (!isSupersededError(error)) throw error;
			this.options.logger.info("OMP restart was superseded by a stop");
		}
	}

	/** Rebuilds the service with fresh settings, keeping the current session; waits for a running restart first. */
	recreate(): Promise<void> {
		return this.change(async () => {
			const sessionFile = this.current?.session.sessionFile;
			await this.stop();
			if (!this.createService()) return;
			this.startInBackground(this.options.resumeOptions(sessionFile));
		});
	}

	private change(run: () => Promise<void>): Promise<void> {
		const previous = this.changing;
		const next = (async () => {
			if (previous) await previous.catch(() => undefined);
			await run();
		})();
		const tracked = next.finally(() => {
			if (this.changing === tracked) this.changing = undefined;
		});
		this.changing = tracked;
		return tracked;
	}

	async stop(): Promise<void> {
		const service = this.current;
		this.current = undefined;
		this.starting = undefined;
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.subscriptions = [];
		void this.setContext("omp.busy", false);
		void this.setContext("omp.hasThinkingLevels", false);
		if (!service) return;
		for (const consumer of this.options.consumers) consumer.setService(undefined);
		try {
			await service.stop();
		} finally {
			service.dispose();
		}
	}

	/** Stops OMP for good: a restart or recreation still in progress creates no new service. */
	shutdown(): Promise<void> {
		this.disposed = true;
		return this.stop();
	}

	dispose(): void {
		this.disposed = true;
		const service = this.current;
		this.current = undefined;
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.trustSubscription.dispose();
		service?.dispose();
	}
}
