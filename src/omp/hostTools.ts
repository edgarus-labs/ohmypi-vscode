import { errorMessage } from "../shared/errors";
import type { HostTools, Logger } from "./api";
import type { OmpRpcClient } from "./client";
import type { HostToolCallFrame } from "./protocol";

/** Longest host tool text sent to OMP, marker included. */
export const MAX_HOST_TOOL_TEXT = 40_000;
const MARKER_RESERVE = 200;

/**
 * Shortens `text` to {@link MAX_HOST_TOOL_TEXT}, keeping its start and cutting at a line break
 * in the second half of the kept part; the marker counts the dropped characters, then `hint`.
 */
export function truncateToolText(text: string, hint = ""): string {
	if (text.length <= MAX_HOST_TOOL_TEXT) return text;
	const keep = MAX_HOST_TOOL_TEXT - MARKER_RESERVE;
	let cut = text.lastIndexOf("\n", keep - 1);
	if (cut < keep / 2) cut = keep;
	return `${text.slice(0, cut)}\n… [truncated: ${text.length - cut} more characters${hint}]`;
}

/**
 * Runs OMP's `host_tool_call`s on the host's tools and answers each one: the tool's text,
 * its error message, or `<name> was cancelled` once OMP cancels the call.
 */
export class HostToolCalls {
	readonly #tools: HostTools;
	readonly #logger: Logger;
	readonly #inFlight = new Map<string, AbortController>();

	constructor(tools: HostTools, logger: Logger) {
		this.#tools = tools;
		this.#logger = logger;
	}

	/** Takes over `client`'s host tool frames; results of a client no longer current are dropped. */
	attach(client: OmpRpcClient, isCurrent: () => boolean): void {
		client.handleHostTools({
			call: frame => this.#call(client, isCurrent, frame),
			cancel: targetId => this.#inFlight.get(targetId)?.abort(),
		});
	}

	/** Aborts every call in flight; their process is gone, so none of them is answered. */
	abortAll(): void {
		for (const controller of this.#inFlight.values()) controller.abort();
		this.#inFlight.clear();
	}

	#call(client: OmpRpcClient, isCurrent: () => boolean, frame: HostToolCallFrame): void {
		const controller = new AbortController();
		this.#inFlight.set(frame.id, controller);
		void this.#run(frame.toolName, frame.arguments, controller.signal)
			.then(({ text, isError }) => {
				if (this.#inFlight.get(frame.id) === controller) this.#inFlight.delete(frame.id);
				if (!isCurrent()) {
					this.#logger.debug(`Result of host tool ${frame.toolName} dropped; its OMP process is gone`);
					return;
				}
				client.sendHostToolResult(frame.id, text, isError);
			})
			.catch(error => this.#logger.error(`Failed to answer host tool ${frame.toolName}`, error));
	}

	async #run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
		const cancelled = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		try {
			const text = await Promise.race([this.#tools.invoke(name, args, signal), cancelled]);
			return { text: truncateToolText(text), isError: false };
		} catch (error) {
			if (signal.aborted) return { text: `${name} was cancelled`, isError: true };
			this.#logger.warn(`Host tool ${name} failed: ${errorMessage(error)}`);
			return { text: errorMessage(error), isError: true };
		}
	}
}
