import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Event, Logger } from "./api";
import type { OmpTransport, TransportClose } from "./client";
import { Emitter } from "./emitter";

export interface OmpProcessOptions {
	executable: string;
	/** Arguments appended after `--mode rpc-ui`. */
	args: readonly string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	logger: Logger;
}

const DEFAULT_GRACE_MS = 3000;
/** How long to wait for stdio to drain after the process exits before reporting the close. */
const STDIO_DRAIN_MS = 1000;

/**
 * One `omp --mode rpc-ui` child process. On POSIX it leads its own process
 * group so shutdown and exit cleanup reach every descendant; on Windows the
 * tree is killed with `taskkill /T /F`.
 */
export class OmpProcess implements OmpTransport {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #logger: Logger;
	readonly #data: Emitter<Uint8Array>;
	readonly #close: Emitter<TransportClose>;
	readonly #closed = Promise.withResolvers<TransportClose>();
	readonly onData: Event<Uint8Array>;
	readonly onClose: Event<TransportClose>;
	#exited = false;
	#reported = false;
	#stderrTail = "";
	#shutdown: Promise<void> | undefined;

	constructor(options: OmpProcessOptions) {
		this.#logger = options.logger;
		const win = process.platform === "win32";
		this.#child = spawn(options.executable, ["--mode", "rpc-ui", ...options.args], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: !win,
			windowsHide: true,
			shell: win && /\.(cmd|bat)$/i.test(options.executable),
		});
		const child = this.#child;
		const onListenerError = (error: unknown) => this.#logger.error("OMP process listener failed", error);
		this.#data = new Emitter<Uint8Array>(onListenerError);
		this.#close = new Emitter<TransportClose>(onListenerError);
		this.onData = this.#data.event;
		this.onClose = this.#close.event;

		child.stdout.on("data", (chunk: Buffer) => this.#data.fire(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.#stderr(chunk.toString("utf8")));
		child.stdin.on("error", error => this.#logger.debug(`OMP stdin error: ${error.message}`));
		child.stdout.on("error", error => this.#logger.warn(`OMP stdout error: ${error.message}`));
		child.stderr.on("error", error => this.#logger.debug(`OMP stderr error: ${error.message}`));

		child.on("error", error => {
			if (child.pid === undefined) {
				this.#exited = true;
				this.#report({ code: null, signal: null, error });
			} else {
				this.#logger.warn(`OMP process error: ${error.message}`);
			}
		});
		child.on("exit", (code, signal) => {
			this.#exited = true;
			this.#killLeftovers();
			const timer = setTimeout(() => this.#report({ code, signal }), STDIO_DRAIN_MS);
			child.once("close", () => {
				clearTimeout(timer);
				this.#report({ code, signal });
			});
		});
	}

	get pid(): number | undefined {
		return this.#child.pid;
	}

	get exited(): boolean {
		return this.#exited;
	}

	write(line: string): void {
		const stdin = this.#child.stdin;
		if (this.#exited || this.#shutdown || stdin.destroyed || !stdin.writable) {
			throw new Error("OMP process is not running");
		}
		stdin.write(line);
	}

	/**
	 * Close stdin and keep reading stdout until OMP exits; after `graceMs`
	 * send SIGTERM to the process tree, then SIGKILL. Idempotent.
	 */
	shutdown(graceMs = DEFAULT_GRACE_MS): Promise<void> {
		this.#shutdown ??= this.#runShutdown(graceMs);
		return this.#shutdown;
	}

	async #runShutdown(graceMs: number): Promise<void> {
		if (!this.#exited) {
			this.#child.stdin.end();
			if (!(await this.#waitForExit(graceMs))) {
				this.#logger.info(`OMP did not exit within ${graceMs} ms of closing stdin; sending SIGTERM`);
				this.#killTree("SIGTERM");
				if (!(await this.#waitForExit(graceMs))) {
					this.#logger.warn("OMP ignored SIGTERM; sending SIGKILL");
					this.#killTree("SIGKILL");
					if (!(await this.#waitForExit(graceMs))) {
						throw new Error(`OMP process ${this.#child.pid} did not exit after SIGKILL`);
					}
				}
			}
		}
		await this.#closed.promise;
	}

	async #waitForExit(ms: number): Promise<boolean> {
		if (this.#exited) return true;
		const exited = Promise.withResolvers<boolean>();
		const timer = setTimeout(() => exited.resolve(false), ms);
		const onExit = () => exited.resolve(true);
		this.#child.once("exit", onExit);
		const result = await exited.promise;
		clearTimeout(timer);
		this.#child.off("exit", onExit);
		return result;
	}

	#killTree(signal: NodeJS.Signals): void {
		const pid = this.#child.pid;
		if (pid === undefined) return;
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			killer.on("error", error => this.#logger.warn(`taskkill failed: ${error.message}`));
			return;
		}
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
				this.#logger.warn(`Failed to send ${signal} to OMP process group ${pid}: ${(error as Error).message}`);
			}
		}
	}

	/** Descendants that outlived OMP would be orphaned; the group dies with its leader. */
	#killLeftovers(): void {
		if (process.platform !== "win32") this.#killTree("SIGKILL");
	}

	#stderr(text: string): void {
		const lines = (this.#stderrTail + text).split(/\r?\n/);
		this.#stderrTail = lines.pop() ?? "";
		for (const line of lines) if (line.trim() !== "") this.#logger.debug(`omp: ${line}`);
	}

	#report(close: TransportClose): void {
		if (this.#reported) return;
		this.#reported = true;
		if (this.#stderrTail.trim() !== "") this.#logger.debug(`omp: ${this.#stderrTail}`);
		this.#stderrTail = "";
		this.#closed.resolve(close);
		this.#close.fire(close);
	}
}
