import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { deferred } from "../shared/deferred";
import type { Event, Logger } from "./api";
import type { OmpTransport, TransportClose } from "./client";
import { Emitter } from "./emitter";

export interface OmpProcessOptions {
	executable: string;
	/** The command OMP runs; `--mode rpc-ui` when absent. */
	mode?: readonly string[];
	/** Arguments appended after the mode. */
	args: readonly string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	logger: Logger;
}

const DEFAULT_GRACE_MS = 3000;
/** How long to wait for stdio to drain after the process exits before reporting the close. */
const STDIO_DRAIN_MS = 1000;
/** Bounds of the stderr tail reported with the close. */
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_CHARS = 4000;
/** Longest stderr line logged whole; longer output without a newline is logged in pieces of this size. */
const STDERR_LINE_CHARS = 64 * 1024;

/**
 * One OMP child process (`omp --mode rpc-ui` unless another mode is given). On
 * POSIX it leads its own process group, so shutdown and the cleanup after OMP
 * exits reach every descendant. On Windows shutdown ends the tree with
 * `taskkill /T /F`, but descendants that outlive an OMP that exited by itself
 * are not reached: Windows has no group to signal once their parent is gone.
 * Once the close is reported, no further output is delivered.
 */
export class OmpProcess implements OmpTransport {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #logger: Logger;
	readonly #data: Emitter<Uint8Array>;
	readonly #close: Emitter<TransportClose>;
	readonly #closed = deferred<TransportClose>();
	readonly onData: Event<Uint8Array>;
	readonly onClose: Event<TransportClose>;
	#exited = false;
	#reported = false;
	readonly #stderrDecoder = new StringDecoder("utf8");
	/** Stderr text after the last newline. */
	#stderrPartial = "";
	readonly #stderrLines: string[] = [];
	#shutdown: Promise<void> | undefined;

	constructor(options: OmpProcessOptions) {
		this.#logger = options.logger;
		const win = process.platform === "win32";
		const [file, args, verbatim] = launchCommand(options.executable, [...(options.mode ?? ["--mode", "rpc-ui"]), ...options.args], options.cwd, win);
		this.#child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: !win,
			windowsHide: true,
			windowsVerbatimArguments: verbatim,
		});
		const child = this.#child;
		const onListenerError = (error: unknown) => this.#logger.error("OMP process listener failed", error);
		this.#data = new Emitter<Uint8Array>(onListenerError);
		this.#close = new Emitter<TransportClose>(onListenerError);
		this.onData = this.#data.event;
		this.onClose = this.#close.event;

		child.stdout.on("data", (chunk: Buffer) => this.#data.fire(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.#stderr(this.#stderrDecoder.write(chunk)));
		// A failed write is reported to its writer through the write callback; this event repeats it.
		child.stdin.on("error", error => this.#logger.debug("OMP stdin error", error));
		child.stdout.on("error", error => this.#logger.warn("OMP stdout error", error));
		child.stderr.on("error", error => this.#logger.debug("OMP stderr error", error));

		child.on("error", error => {
			if (child.pid === undefined) {
				this.#exited = true;
				this.#report({ code: null, signal: null, error });
			} else {
				this.#logger.warn("OMP process error", error);
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

	write(line: string, onError?: (error: Error) => void): void {
		const stdin = this.#child.stdin;
		if (this.#exited || this.#shutdown || stdin.destroyed || !stdin.writable) {
			throw new Error("OMP process is not running");
		}
		stdin.write(line, error => {
			if (!error) return;
			if (onError) onError(error);
			else this.#logger.warn("Failed to write to OMP stdin", error);
		});
	}

	/**
	 * Close stdin and keep reading stdout until OMP exits; after `graceMs`
	 * send SIGTERM to the process group, then SIGKILL. Windows has no graceful
	 * signal, so both steps end the tree with `taskkill /T /F`. Idempotent.
	 */
	shutdown(graceMs = DEFAULT_GRACE_MS): Promise<void> {
		this.#shutdown ??= this.#runShutdown(graceMs);
		return this.#shutdown;
	}

	async #runShutdown(graceMs: number): Promise<void> {
		if (!this.#exited) {
			const win = process.platform === "win32";
			this.#child.stdin.end();
			if (!(await this.#waitForExit(graceMs))) {
				this.#logger.info(
					`OMP did not exit within ${graceMs} ms of closing stdin; ${win ? "killing its process tree with taskkill /T /F" : "sending SIGTERM"}`,
				);
				this.#killTree("SIGTERM");
				if (!(await this.#waitForExit(graceMs))) {
					this.#logger.warn(win ? "OMP survived taskkill /T /F; running it again" : "OMP ignored SIGTERM; sending SIGKILL");
					this.#killTree("SIGKILL");
					if (!(await this.#waitForExit(graceMs))) {
						throw new Error(`OMP process ${this.#child.pid} did not exit after ${win ? "taskkill /T /F" : "SIGKILL"}`);
					}
				}
			}
		}
		await this.#closed.promise;
	}

	async #waitForExit(ms: number): Promise<boolean> {
		if (this.#exited) return true;
		const exited = deferred<boolean>();
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
		if (pid !== undefined) void killProcessTree(pid, signal, this.#logger);
	}

	/** Descendants that outlived OMP would be orphaned; the group dies with its leader. */
	#killLeftovers(): void {
		if (process.platform !== "win32") this.#killTree("SIGKILL");
	}

	#stderr(text: string): void {
		const lines = (this.#stderrPartial + text).split(/\r?\n/);
		let partial = lines.pop() ?? "";
		for (const line of lines) this.#stderrLine(line);
		for (; partial.length > STDERR_LINE_CHARS; partial = partial.slice(STDERR_LINE_CHARS)) {
			this.#stderrLine(partial.slice(0, STDERR_LINE_CHARS));
		}
		this.#stderrPartial = partial;
	}

	#stderrLine(line: string): void {
		if (line.trim() === "") return;
		this.#logger.debug(`omp: ${line}`);
		this.#stderrLines.push(line);
		if (this.#stderrLines.length > STDERR_TAIL_LINES) this.#stderrLines.shift();
	}

	#report(close: TransportClose): void {
		if (this.#reported) return;
		this.#reported = true;
		// A descendant that escaped the tree may still hold the pipes; stop reading them.
		this.#child.stdout.destroy();
		this.#child.stderr.destroy();
		this.#stderr(this.#stderrDecoder.end());
		this.#stderrLine(this.#stderrPartial);
		this.#stderrPartial = "";
		const pid = this.#child.pid;
		const tail = this.#stderrLines.join("\n");
		const stderr = tail.length > STDERR_TAIL_CHARS ? `…${tail.slice(tail.length - STDERR_TAIL_CHARS + 1)}` : tail;
		const reported: TransportClose = { ...close, ...(pid === undefined ? {} : { pid }), ...(stderr === "" ? {} : { stderr }) };
		this.#closed.resolve(reported);
		this.#close.fire(reported);
	}
}

/**
 * Send `signal` to the process group led by `pid`; on Windows, where signals do
 * not exist, end the whole tree with `taskkill /T /F`. Failures are logged.
 * @returns Resolves once the signal is sent or taskkill has finished.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals, logger: Logger): Promise<void> {
	if (process.platform === "win32") {
		const done = deferred<void>();
		const command = `taskkill /pid ${pid} /T /F`;
		const killer = spawn(systemProgram("taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
		const stderr: Buffer[] = [];
		killer.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		killer.on("error", error => {
			logger.warn(`${command} failed to start`, error);
			done.resolve();
		});
		killer.on("close", code => {
			if (code !== 0 && code !== null) logger.warn(`${command} exited with code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`);
			done.resolve();
		});
		return done.promise;
	}
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			logger.warn(`Failed to send ${signal} to OMP process group ${pid}`, error);
		}
	}
	return Promise.resolve();
}

/** A program in the Windows system directory, by full path: a bare name is looked up in the working directory first. */
function systemProgram(name: string): string {
	return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

/** cmd.exe metacharacters; `^` makes the next one literal. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** A UNC path (`\\server\share\…`), which cmd.exe cannot use as its working directory. */
const UNC_PATH = /^[\\/]{2}/;

/**
 * Windows runs `.cmd`/`.bat` launchers (npm installs `omp.cmd`) only through
 * cmd.exe, which re-parses the command line, so the path and every argument
 * are quoted and caret-escaped. Arguments are escaped twice because the
 * launcher re-parses them again when it expands `%*`. cmd.exe replaces a UNC
 * working directory with the Windows directory, so such a launch throws.
 */
function launchCommand(executable: string, args: string[], cwd: string, win: boolean): [string, string[], boolean] {
	if (!win || !/\.(cmd|bat)$/i.test(executable)) return [executable, args, false];
	if (UNC_PATH.test(cwd)) {
		throw new Error(`${path.win32.basename(executable)} runs through cmd.exe, which cannot run in the UNC folder ${cwd}; set omp.executablePath to omp.exe`);
	}
	const line = [executable.replace(CMD_META, "^$1"), ...args.map(cmdArgument)].join(" ");
	return [process.env.ComSpec ?? systemProgram("cmd.exe"), ["/d", "/s", "/c", `"${line}"`], true];
}

function cmdArgument(arg: string): string {
	const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}
