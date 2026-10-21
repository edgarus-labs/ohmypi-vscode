import { type Deferred, deferred } from "../shared/deferred";
import { errorMessage } from "../shared/errors";
import { type ConnectionStatus, type Event, isSupersededError, type Logger, type OmpServiceOptions, type SessionBinding } from "./api";
import { describeClose, OmpRpcClient, type OmpTransport, type TransportClose } from "./client";
import { Emitter } from "./emitter";
import { OmpProcess, type OmpProcessOptions } from "./process";

/** OMP child process as the lifecycle drives it. */
export interface OmpProcessHandle extends OmpTransport {
	readonly pid: number | undefined;
	shutdown(graceMs: number): Promise<void>;
}

/** Restart/shutdown timing; production uses the defaults. */
export interface LifecycleTuning {
	/** Delay before each automatic restart; its length is the restart budget per window. */
	restartDelaysMs?: number[];
	restartWindowMs?: number;
	shutdownGraceMs?: number;
	readyTimeoutMs?: number;
	/** Creates the OMP process; tests substitute an in-memory one. */
	spawn?: (options: OmpProcessOptions) => OmpProcessHandle;
}

/** What the lifecycle needs from the session layer above it. */
export interface LifecycleHooks {
	/** Subscribes to a new client's events; `isCurrent` turns false once its process is let go. */
	attach(client: OmpRpcClient, isCurrent: () => boolean): void;
	/** Configures a client that sent `ready` and binds its session; resolves to a warning shown once OMP is ready. */
	prepare(client: OmpRpcClient, binding: SessionBinding): Promise<string | undefined>;
	/** The current process was let go: end everything that waits on it. */
	detached(reason: string): void;
	/** Shows a transcript notice. */
	notice(level: "warning" | "error", text: string): void;
	/** Session file a restart re-binds. */
	sessionFile(): string | undefined;
}

/** Rejection of a start whose launch a later `restart()`/`stop()` cancelled (see `isSupersededError`). */
export class SupersededError extends Error {
	readonly code = "superseded";

	constructor() {
		super("OMP start was cancelled by a later restart or stop");
	}
}

interface LifecycleNotice {
	level: "warning" | "error";
	text: string;
}

const DEFAULT_RESTART_DELAYS_MS = [500, 2000, 5000];

/** Appends `suffix` to the first line of `detail`, ahead of the stderr tail `describeClose` puts below it. */
function onFirstLine(detail: string, suffix: string): string {
	const end = detail.indexOf("\n");
	return end < 0 ? `${detail}${suffix}` : `${detail.slice(0, end)}${suffix}${detail.slice(end)}`;
}

/**
 * Supervises the OMP process: launch and handshake, serialized start/stop/restart,
 * cancellation of superseded launches, and automatic restarts within a budget.
 */
export class ProcessLifecycle {
	readonly #options: OmpServiceOptions;
	readonly #logger: Logger;
	readonly #hooks: LifecycleHooks;
	readonly #restartDelaysMs: number[];
	readonly #restartWindowMs: number;
	readonly #graceMs: number;
	readonly #readyTimeoutMs: number;
	readonly #spawn: (options: OmpProcessOptions) => OmpProcessHandle;
	readonly #change: Emitter<ConnectionStatus>;
	readonly onDidChange: Event<ConnectionStatus>;

	#connection: ConnectionStatus = { state: "stopped" };
	#process: OmpProcessHandle | undefined;
	#client: OmpRpcClient | undefined;
	/** Bumped whenever the current process is let go; events of older generations are ignored. */
	#generation = 0;
	/** Rejecting it abandons the launch in flight at its next step. */
	#launchCancel: Deferred<never> | undefined;
	/** Bumped by stop/restart: a queued start or restart from an older epoch is superseded. */
	#epoch = 0;
	/** start/stop/restart and automatic restarts run one at a time, in call order. */
	#queue: Promise<void> = Promise.resolve();
	#restartTimes: number[] = [];
	#restartTimer: NodeJS.Timeout | undefined;
	/** Notices raised since the last completed launch; that launch's history reload drops them from the transcript. */
	#notices: LifecycleNotice[] = [];

	constructor(options: OmpServiceOptions, tuning: LifecycleTuning, hooks: LifecycleHooks, onListenerError: (error: unknown) => void) {
		this.#options = options;
		this.#logger = options.logger;
		this.#hooks = hooks;
		this.#restartDelaysMs = tuning.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
		this.#restartWindowMs = tuning.restartWindowMs ?? 60_000;
		this.#graceMs = tuning.shutdownGraceMs ?? 3000;
		this.#readyTimeoutMs = tuning.readyTimeoutMs ?? 30_000;
		this.#spawn = tuning.spawn ?? (processOptions => new OmpProcess(processOptions));
		this.#change = new Emitter(onListenerError);
		this.onDidChange = this.#change.event;
	}

	get connection(): ConnectionStatus {
		return this.#connection;
	}

	/** The client of the current process, from its spawn until it is let go; it may not be ready yet. */
	get client(): OmpRpcClient | undefined {
		return this.#client;
	}

	/** The current client while OMP is ready. */
	get readyClient(): OmpRpcClient | undefined {
		return this.#connection.state === "ready" ? this.#client : undefined;
	}

	notRunning(): Error {
		return new Error(`OMP is not running (${this.#connection.state})`);
	}

	/**
	 * Launches OMP; clears a pending automatic restart, including one that a restart attempt failing
	 * ahead of this start schedules. Throws while OMP is already running.
	 */
	start(binding: SessionBinding): Promise<void> {
		this.#cancelRestart();
		const epoch = this.#epoch;
		return this.#serialize(async () => {
			this.#cancelRestart();
			if (this.#client) throw new Error("OMP is already running");
			await this.#startReporting(binding, epoch);
		});
	}

	/** Stops and launches again on the current session file; supersedes a launch in flight. */
	restart(): Promise<void> {
		const epoch = this.#supersede();
		return this.#serialize(async () => {
			if (epoch !== this.#epoch) throw new SupersededError();
			const sessionFile = this.#hooks.sessionFile();
			await this.#stop();
			await this.#startReporting({ resumeSessionFile: sessionFile }, epoch);
		});
	}

	/** Shuts the process down; supersedes a launch in flight and cancels a pending automatic restart. */
	stop(): Promise<void> {
		this.#supersede();
		return this.#serialize(() => this.#stop());
	}

	dispose(): void {
		this.#change.dispose();
	}

	#setConnection(status: ConnectionStatus): void {
		this.#connection = status;
		this.#change.fire(status);
	}

	/** Runs `operation` once every earlier lifecycle operation has settled. */
	#serialize(operation: () => Promise<void>): Promise<void> {
		const result = this.#queue.then(operation);
		this.#queue = result.catch(() => undefined);
		return result;
	}

	/** Cancels the pending automatic restart, the launch in flight and every queued start/restart; returns the new epoch. */
	#supersede(): number {
		this.#cancelRestart();
		this.#launchCancel?.reject(new SupersededError());
		return ++this.#epoch;
	}

	#cancelRestart(): void {
		clearTimeout(this.#restartTimer);
		this.#restartTimer = undefined;
	}

	/** A launch asked for by `start()`/`restart()`; any failure but supersession leaves the connection `failed`. */
	async #startReporting(binding: SessionBinding, epoch: number): Promise<void> {
		this.#restartTimes = [];
		this.#notices = [];
		try {
			await this.#launch(binding, "starting", epoch);
		} catch (error) {
			if (!isSupersededError(error)) {
				this.#setConnection({ state: "failed", detail: errorMessage(error), executable: this.#options.executable });
			}
			throw error;
		}
	}

	async #stop(): Promise<void> {
		const proc = this.#process;
		const client = this.#client;
		if (proc) {
			this.#detach("OMP was stopped");
			try {
				await proc.shutdown(this.#graceMs);
			} catch (error) {
				this.#setConnection({
					state: "failed",
					detail: `OMP could not be stopped: ${errorMessage(error)}`,
					executable: this.#options.executable,
				});
				throw error;
			} finally {
				client?.dispose();
			}
		}
		this.#setConnection({ state: "stopped", detail: this.#connection.detail, executable: this.#options.executable });
	}

	/** Lets go of the current process: its events are ignored from now on. */
	#detach(reason: string): void {
		this.#generation++;
		this.#process = undefined;
		this.#client = undefined;
		this.#hooks.detached(reason);
	}

	async #launch(binding: SessionBinding, state: "starting" | "restarting", epoch: number, detail?: string): Promise<void> {
		if (epoch !== this.#epoch) throw new SupersededError();
		const generation = ++this.#generation;
		const { executable, extraArgs, cwd, env } = this.#options;
		this.#setConnection({ state, detail, executable });
		const cancelled = deferred<never>();
		cancelled.promise.catch(() => undefined);
		this.#launchCancel = cancelled;
		const step = <T>(work: Promise<T>) => Promise.race([work, cancelled.promise]);
		let proc: OmpProcessHandle | undefined;
		let client: OmpRpcClient | undefined;
		let warning: string | undefined;
		try {
			proc = this.#spawn({ executable, args: extraArgs, cwd, env, logger: this.#logger });
			client = new OmpRpcClient(proc, {
				logger: this.#logger,
				readyTimeoutMs: this.#readyTimeoutMs,
				requestTimeoutMs: this.#options.requestTimeoutMs,
			});
			this.#process = proc;
			this.#client = client;
			const isCurrent = () => generation === this.#generation;
			client.onClose(close => {
				if (isCurrent()) this.#onClose(close);
			});
			this.#hooks.attach(client, isCurrent);
			await step(client.start());
			warning = await step(this.#hooks.prepare(client, binding));
		} catch (error) {
			if (generation === this.#generation) this.#detach(errorMessage(error));
			await proc?.shutdown(this.#graceMs).catch(shutdownError => this.#logger.error("Failed to shut down OMP after a failed start", shutdownError));
			client?.dispose();
			throw error;
		} finally {
			this.#launchCancel = undefined;
		}
		for (const notice of this.#notices) this.#hooks.notice(notice.level, notice.text);
		this.#notices = [];
		if (warning) this.#hooks.notice("warning", warning);
		this.#setConnection({ state: "ready", pid: proc.pid, executable, protocolVersion: client.protocolVersion });
		this.#logger.info(`OMP ready (pid ${proc.pid}, protocol v${client.protocolVersion})`);
	}

	/** Shows a notice that the next launch shows again after its history reload. */
	#notice(level: "warning" | "error", text: string): void {
		this.#notices.push({ level, text });
		this.#hooks.notice(level, text);
	}

	#onClose(close: TransportClose): void {
		const exit = describeClose(close);
		this.#client?.dispose();
		this.#detach(exit);
		// A launch in flight fails with this close and reports it itself.
		if (this.#launchCancel) return;

		const unexpected = onFirstLine(exit, " unexpectedly");
		this.#logger.warn(unexpected);
		if (!this.#options.autoRestart) {
			this.#notice("error", unexpected);
			this.#setConnection({ state: "failed", detail: exit, executable: this.#options.executable });
			return;
		}
		this.#scheduleRestart(unexpected);
	}

	#scheduleRestart(detail: string): void {
		const { executable } = this.#options;
		const now = Date.now();
		this.#restartTimes = this.#restartTimes.filter(time => now - time < this.#restartWindowMs);
		const attempt = this.#restartTimes.length;
		const budget = this.#restartDelaysMs.length;
		if (attempt >= budget) {
			const gaveUp = onFirstLine(detail, `; gave up after ${attempt} restarts within ${Math.round(this.#restartWindowMs / 1000)}s`);
			this.#logger.error(gaveUp);
			this.#notice("error", gaveUp);
			this.#setConnection({ state: "failed", detail: gaveUp, executable });
			return;
		}
		this.#restartTimes.push(now);
		const delay = this.#restartDelaysMs[attempt];
		const sessionFile = this.#hooks.sessionFile();
		this.#notice("error", onFirstLine(detail, `; OMP will be restarted (attempt ${attempt + 1} of ${budget})`));
		this.#setConnection({ state: "restarting", detail: onFirstLine(detail, `; restart ${attempt + 1}/${budget} in ${delay} ms`), executable });
		const epoch = this.#epoch;
		const timer = setTimeout(() => {
			this.#serialize(async () => {
				if (this.#restartTimer !== timer) return;
				this.#restartTimer = undefined;
				await this.#launch({ resumeSessionFile: sessionFile }, "restarting", epoch, detail);
			}).catch(error => {
				if (isSupersededError(error) || epoch !== this.#epoch) return;
				this.#logger.error("OMP restart failed", error);
				this.#scheduleRestart(`OMP restart failed: ${errorMessage(error)}`);
			});
		}, delay);
		this.#restartTimer = timer;
	}
}
