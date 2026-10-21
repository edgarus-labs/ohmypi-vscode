import { deferred } from "../shared/deferred";
import { isRecord } from "../shared/guards";
import type { Disposable, Event, Logger } from "./api";
import { Emitter } from "./emitter";
import { ChunkReassembler, DEFAULT_CHUNK_LIMITS, JsonlDecoder } from "./jsonl";
import {
	type AvailableCommandsUpdateFrame,
	type CommandMap,
	type CommandOutputFrame,
	type CommandType,
	type ConfigUpdateFrame,
	type ExtensionUiRequest,
	type ExtensionUiResponse,
	type HostToolCallFrame,
	type HostToolCancelFrame,
	type HostUriRequestFrame,
	type PromptResultFrame,
	type ReadyFrame,
	type ResponseFrame,
	SESSION_EVENT_TYPES,
	type SessionEvent,
	type SessionInfoUpdateFrame,
	type SubagentFrame,
	type UnknownFrame,
} from "./protocol";

export interface TransportClose {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** Spawn or pipe failure that ended the transport. */
	error?: Error;
	/** Id of the process that ended, when it was spawned. */
	pid?: number;
	/** The last lines OMP wrote to stderr, newline-separated and bounded; absent when there were none. */
	stderr?: string;
}

/** Byte stream to and from one OMP process (a child process, or in-memory in tests). */
export interface OmpTransport {
	/**
	 * Write one JSONL line. Throws when the transport can no longer accept input;
	 * `onError` receives a failure the transport detects only after accepting the line.
	 */
	write(line: string, onError?: (error: Error) => void): void;
	readonly onData: Event<Uint8Array>;
	readonly onClose: Event<TransportClose>;
}

/**
 * A command failed. `code` is OMP's machine-readable code when the server sent
 * one, otherwise `timeout`, `closed`, `write_failed` or `duplicate_id` for local failures.
 */
export class OmpRequestError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "OmpRequestError";
	}
}

export interface RequestOptions {
	/** 0 disables the timeout. */
	timeoutMs?: number;
	/** Caller-chosen id, e.g. to correlate a prompt with its `prompt_result`; must not match a request still pending. */
	id?: string;
}

export interface OmpRpcClientOptions {
	/** Frames are traced through `logger.trace` while `logger.traceEnabled` is on. */
	logger: Logger;
	/** How long `start` waits for the `ready` frame; 0 waits without a deadline. */
	readyTimeoutMs?: number;
	requestTimeoutMs?: number;
}

/** Receives OMP's host tool frames; without one the client refuses every call. */
export interface HostToolFrameHandler {
	/** OMP asks the host to run a tool; answer with {@link OmpRpcClient.sendHostToolResult}. */
	call(frame: HostToolCallFrame): void;
	/** OMP no longer needs the result of the call with request id `targetId`. */
	cancel(targetId: string): void;
}

export type RequestArgs<K extends CommandType> = CommandMap[K]["params"] extends undefined
	? [params?: undefined, options?: RequestOptions]
	: [params: CommandMap[K]["params"], options?: RequestOptions];

interface PendingRequest {
	command: string;
	resolve(data: unknown): void;
	reject(error: OmpRequestError): void;
	timer?: NodeJS.Timeout;
}

const TRACE_STRING_LIMIT = 200;
const TRACE_FRAME_LIMIT = 2000;
/** Codes of requests that failed in the client or transport, without an answer from OMP. */
const LOCAL_FAILURES: ReadonlySet<string | undefined> = new Set(["timeout", "closed", "write_failed", "duplicate_id"]);

function abbreviate(frame: unknown): string {
	const json = JSON.stringify(frame, (_key, value: unknown) =>
		typeof value === "string" && value.length > TRACE_STRING_LIMIT
			? `${value.slice(0, TRACE_STRING_LIMIT)}…(${value.length} chars)`
			: value,
	);
	return json.length > TRACE_FRAME_LIMIT ? `${json.slice(0, TRACE_FRAME_LIMIT)}…` : json;
}

function closeSummary(close: TransportClose): string {
	if (close.error) return `OMP process failed: ${close.error.message}`;
	const name = close.pid === undefined ? "OMP process" : `OMP process ${close.pid}`;
	return close.signal ? `${name} exited (signal ${close.signal})` : `${name} exited (code ${close.code})`;
}

/**
 * How an OMP transport ended: one summary line naming the process, followed by
 * OMP's last stderr lines when it wrote any.
 */
export function describeClose(close: TransportClose): string {
	const summary = closeSummary(close);
	return close.stderr ? `${summary}\nOMP stderr (last lines):\n${close.stderr}` : summary;
}

/**
 * Typed OMP RPC client: handshake, request/response correlation and frame
 * dispatch over an {@link OmpTransport}.
 */
export class OmpRpcClient implements Disposable {
	readonly #transport: OmpTransport;
	readonly #logger: Logger;
	readonly #readyTimeoutMs: number;
	readonly #requestTimeoutMs: number;
	readonly #decoder: JsonlDecoder;
	#reassembler = new ChunkReassembler(DEFAULT_CHUNK_LIMITS);
	readonly #pending = new Map<string, PendingRequest>();
	readonly #ready = deferred<ReadyFrame>();
	readonly #subscriptions: Disposable[];
	#readyFrame: ReadyFrame | undefined;
	#closed: TransportClose | undefined;
	#nextId = 0;
	#protocolVersion = 1;
	#hostTools: HostToolFrameHandler | undefined;

	readonly #sessionEvent: Emitter<SessionEvent>;
	readonly #promptResult: Emitter<PromptResultFrame>;
	readonly #sessionSettled: Emitter<void>;
	readonly #uiRequest: Emitter<ExtensionUiRequest>;
	readonly #subagentFrame: Emitter<SubagentFrame>;
	readonly #commandOutput: Emitter<CommandOutputFrame>;
	readonly #sessionInfoUpdate: Emitter<SessionInfoUpdateFrame>;
	readonly #configUpdate: Emitter<ConfigUpdateFrame>;
	readonly #availableCommands: Emitter<AvailableCommandsUpdateFrame>;
	readonly #unknownFrame: Emitter<UnknownFrame>;
	readonly #close: Emitter<TransportClose>;

	readonly onSessionEvent: Event<SessionEvent>;
	readonly onPromptResult: Event<PromptResultFrame>;
	readonly onSessionSettled: Event<void>;
	readonly onUiRequest: Event<ExtensionUiRequest>;
	readonly onSubagentFrame: Event<SubagentFrame>;
	readonly onCommandOutput: Event<CommandOutputFrame>;
	readonly onSessionInfoUpdate: Event<SessionInfoUpdateFrame>;
	readonly onConfigUpdate: Event<ConfigUpdateFrame>;
	/** OMP's slash-command list changed (sent at startup and whenever command metadata changes). */
	readonly onAvailableCommands: Event<AvailableCommandsUpdateFrame>;
	readonly onUnknownFrame: Event<UnknownFrame>;
	/** The transport ended; every pending request has already been rejected. */
	readonly onClose: Event<TransportClose>;

	constructor(transport: OmpTransport, options: OmpRpcClientOptions) {
		this.#transport = transport;
		this.#logger = options.logger;
		this.#readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		// The readiness promise is awaited only by start(); keep an early rejection from going unhandled.
		this.#ready.promise.catch(() => undefined);

		const onListenerError = (error: unknown) => this.#logger.error("OMP event listener failed", error);
		this.#sessionEvent = new Emitter(onListenerError);
		this.#promptResult = new Emitter(onListenerError);
		this.#sessionSettled = new Emitter(onListenerError);
		this.#uiRequest = new Emitter(onListenerError);
		this.#subagentFrame = new Emitter(onListenerError);
		this.#commandOutput = new Emitter(onListenerError);
		this.#sessionInfoUpdate = new Emitter(onListenerError);
		this.#configUpdate = new Emitter(onListenerError);
		this.#availableCommands = new Emitter(onListenerError);
		this.#unknownFrame = new Emitter(onListenerError);
		this.#close = new Emitter(onListenerError);
		this.onSessionEvent = this.#sessionEvent.event;
		this.onPromptResult = this.#promptResult.event;
		this.onSessionSettled = this.#sessionSettled.event;
		this.onUiRequest = this.#uiRequest.event;
		this.onSubagentFrame = this.#subagentFrame.event;
		this.onCommandOutput = this.#commandOutput.event;
		this.onSessionInfoUpdate = this.#sessionInfoUpdate.event;
		this.onConfigUpdate = this.#configUpdate.event;
		this.onAvailableCommands = this.#availableCommands.event;
		this.onUnknownFrame = this.#unknownFrame.event;
		this.onClose = this.#close.event;

		this.#decoder = new JsonlDecoder({
			value: value => this.#receive(value),
			error: error => this.#logger.warn("OMP stdout could not be decoded", error),
		});
		this.#subscriptions = [
			transport.onData(chunk => this.#decoder.push(chunk)),
			transport.onClose(close => this.#handleClose(close)),
		];
	}

	get protocolVersion(): number {
		return this.#protocolVersion;
	}

	/**
	 * Wait for the `ready` frame and negotiate protocol v2 when the server offers it.
	 * A refused negotiation stays on v1; an unanswered one fails, since OMP may have switched.
	 */
	async start(): Promise<void> {
		const timer =
			this.#readyTimeoutMs > 0
				? setTimeout(
						() => this.#ready.reject(new Error(`OMP did not send a ready frame within ${this.#readyTimeoutMs} ms`)),
						this.#readyTimeoutMs,
					)
				: undefined;
		let ready: ReadyFrame;
		try {
			ready = await this.#ready.promise;
		} finally {
			clearTimeout(timer);
		}
		if (!ready.supportedProtocolVersions?.includes(2)) return;
		try {
			const result = await this.request("negotiate_protocol", { protocolVersion: 2 });
			this.#protocolVersion = result.protocolVersion === 2 ? 2 : 1;
		} catch (error) {
			if (!(error instanceof OmpRequestError) || LOCAL_FAILURES.has(error.code)) throw error;
			this.#logger.warn("OMP protocol v2 negotiation failed; staying on v1", error);
		}
	}

	nextId(): string {
		this.#nextId += 1;
		return `req_${this.#nextId}`;
	}

	request<K extends CommandType>(type: K, ...[params, options]: RequestArgs<K>): Promise<CommandMap[K]["result"]> {
		if (this.#closed) {
			return Promise.reject(new OmpRequestError(`${closeSummary(this.#closed)}; cannot send ${type}`, type, "closed"));
		}
		const id = options?.id ?? this.nextId();
		if (this.#pending.has(id)) {
			return Promise.reject(new OmpRequestError(`OMP request id ${id} is already pending; cannot send ${type}`, type, "duplicate_id"));
		}
		const frame = { ...(params ?? {}), id, type };
		const { promise, resolve, reject } = deferred<CommandMap[K]["result"]>();
		const pending: PendingRequest = { command: type, resolve: resolve as (data: unknown) => void, reject };
		const timeoutMs = options?.timeoutMs ?? this.#requestTimeoutMs;
		if (timeoutMs > 0) {
			pending.timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new OmpRequestError(`OMP command ${type} timed out after ${timeoutMs} ms`, type, "timeout"));
			}, timeoutMs);
		}
		this.#pending.set(id, pending);
		const writeFailed = (error: Error) => {
			if (this.#pending.get(id) !== pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			reject(new OmpRequestError(`Failed to send ${type} to OMP: ${error.message}`, type, "write_failed"));
		};
		try {
			this.#write(frame, frame, writeFailed);
		} catch (error) {
			writeFailed(error as Error);
		}
		return promise;
	}

	/**
	 * Answer an extension UI request. `secret` responses are written verbatim but
	 * never traced.
	 */
	sendUiResponse(response: ExtensionUiResponse, secret = false): void {
		const traced = secret && "value" in response ? { ...response, value: "[redacted]" } : response;
		this.#write(response, traced, this.#reportWriteFailure(response.type));
	}

	/** Routes `host_tool_call`/`host_tool_cancel` frames to `handler` instead of refusing them. */
	handleHostTools(handler: HostToolFrameHandler): void {
		this.#hostTools = handler;
	}

	/** Completes host tool call `id` with one text block. */
	sendHostToolResult(id: string, text: string, isError: boolean): void {
		const frame = { type: "host_tool_result", id, isError, result: { content: [{ type: "text", text }], isError } };
		this.#write(frame, frame, this.#reportWriteFailure(frame.type));
	}

	dispose(): void {
		for (const subscription of this.#subscriptions) subscription.dispose();
		this.#closed ??= { code: null, signal: null, error: new Error("client disposed") };
		this.#rejectAll("OMP client disposed", "closed");
		this.#ready.reject(new Error("OMP client disposed before it was ready"));
		for (const emitter of [
			this.#sessionEvent,
			this.#promptResult,
			this.#sessionSettled,
			this.#uiRequest,
			this.#subagentFrame,
			this.#commandOutput,
			this.#sessionInfoUpdate,
			this.#configUpdate,
			this.#availableCommands,
			this.#unknownFrame,
			this.#close,
		])
			emitter.dispose();
	}

	#write(frame: { type: string }, traced: object = frame, onError?: (error: Error) => void): void {
		const line = `${JSON.stringify(frame)}\n`;
		// OMP never reassembles rpc_chunk input; an oversized command still has to go out as one line.
		const limit = this.#readyFrame?.maxFrameBytes;
		if (limit !== undefined) {
			const bytes = Buffer.byteLength(line, "utf8");
			if (bytes > limit) {
				this.#logger.warn(
					`OMP ${frame.type} frame of ${bytes} bytes exceeds the ${limit}-byte frame limit OMP advertised; sent as one line`,
				);
			}
		}
		this.#transport.write(line, onError);
		if (this.#logger.traceEnabled) this.#logger.trace("out", abbreviate(traced));
	}

	#reportWriteFailure(type: string): (error: Error) => void {
		return error => this.#logger.warn(`Failed to send ${type} to OMP`, error);
	}

	#receive(value: unknown): void {
		const { frame, error } = this.#reassembler.push(value);
		if (error) this.#logger.warn("OMP frame rejected", error);
		if (!frame) return;
		if (this.#logger.traceEnabled) this.#logger.trace("in", abbreviate(frame));
		if (typeof frame.type !== "string") {
			this.#logger.warn(`OMP frame without a type ignored: ${abbreviate(frame)}`);
			return;
		}
		try {
			this.#dispatch(frame as UnknownFrame);
		} catch (dispatchError) {
			this.#logger.error(`Failed to handle OMP ${frame.type} frame`, dispatchError);
		}
	}

	#dispatch(frame: UnknownFrame): void {
		switch (frame.type) {
			case "response":
				this.#handleResponse(frame as unknown as ResponseFrame);
				return;
			case "ready":
				this.#handleReady(frame as ReadyFrame);
				return;
			case "prompt_result":
				this.#promptResult.fire(frame as unknown as PromptResultFrame);
				return;
			case "session_settled":
				this.#sessionSettled.fire();
				return;
			case "extension_ui_request":
				this.#uiRequest.fire(frame as unknown as ExtensionUiRequest);
				return;
			case "subagent_lifecycle":
			case "subagent_progress":
			case "subagent_event":
				this.#subagentFrame.fire(frame as unknown as SubagentFrame);
				return;
			case "command_output":
				this.#commandOutput.fire(frame as unknown as CommandOutputFrame);
				return;
			case "session_info_update":
				this.#sessionInfoUpdate.fire(frame as unknown as SessionInfoUpdateFrame);
				return;
			case "config_update":
				this.#configUpdate.fire(frame as unknown as ConfigUpdateFrame);
				return;
			case "available_commands_update":
				this.#availableCommands.fire(frame as unknown as AvailableCommandsUpdateFrame);
				return;
			case "host_tool_call": {
				const call = frame as unknown as HostToolCallFrame;
				if (this.#hostTools) {
					if (typeof call.id !== "string") {
						this.#logger.warn(`OMP host_tool_call without an id ignored: ${abbreviate(frame)}`);
						return;
					}
					this.#hostTools.call({
						...call,
						toolName: typeof call.toolName === "string" ? call.toolName : "",
						arguments: isRecord(call.arguments) ? call.arguments : {},
					});
					return;
				}
				const text = `Host tool ${call.toolName} is not provided by this client.`;
				const result = { type: "host_tool_result", id: call.id, isError: true, result: { content: [{ type: "text", text }] } };
				this.#write(result, result, this.#reportWriteFailure(result.type));
				return;
			}
			case "host_uri_request": {
				const request = frame as unknown as HostUriRequestFrame;
				const result = { type: "host_uri_result", id: request.id, isError: true, error: `URL ${request.url} is not served by this client.` };
				this.#write(result, result, this.#reportWriteFailure(result.type));
				return;
			}
			case "host_tool_cancel": {
				const { targetId } = frame as unknown as HostToolCancelFrame;
				if (this.#hostTools && typeof targetId === "string") this.#hostTools.cancel(targetId);
				else this.#logger.debug(`OMP ${frame.type} ignored`);
				return;
			}
			case "host_uri_cancel":
				this.#logger.debug(`OMP ${frame.type} ignored`);
				return;
			case "extension_error":
				this.#logger.warn(`OMP extension error (${String(frame.extensionPath)}, ${String(frame.event)}): ${String(frame.error)}`);
				return;
			case "rpc_frame_error":
				this.#logger.warn(`OMP dropped an oversized ${String(frame.originalType ?? "frame")}: ${String(frame.error)}`);
				return;
		}
		if (SESSION_EVENT_TYPES.has(frame.type)) {
			this.#sessionEvent.fire(frame as SessionEvent);
			return;
		}
		this.#logger.debug(`Unknown OMP frame type ${frame.type} ignored`);
		this.#unknownFrame.fire(frame);
	}

	#handleReady(frame: ReadyFrame): void {
		if (this.#readyFrame) {
			this.#logger.debug("Duplicate OMP ready frame ignored");
			return;
		}
		let maxFrameBytes = isPositiveInteger(frame.maxFrameBytes) ? frame.maxFrameBytes : undefined;
		let maxReassembledFrameBytes = isPositiveInteger(frame.maxReassembledFrameBytes) ? frame.maxReassembledFrameBytes : undefined;
		if ((maxFrameBytes ?? DEFAULT_CHUNK_LIMITS.maxFrameBytes) >= (maxReassembledFrameBytes ?? DEFAULT_CHUNK_LIMITS.maxReassembledFrameBytes)) {
			this.#logger.warn(
				`OMP advertised inconsistent frame limits (maxFrameBytes ${String(frame.maxFrameBytes)}, maxReassembledFrameBytes ${String(frame.maxReassembledFrameBytes)}); using the defaults`,
			);
			maxFrameBytes = undefined;
			maxReassembledFrameBytes = undefined;
		}
		this.#readyFrame = { ...frame, maxFrameBytes, maxReassembledFrameBytes };
		if (maxFrameBytes !== undefined) this.#decoder.maxLineBytes = maxFrameBytes;
		this.#reassembler = new ChunkReassembler({
			...DEFAULT_CHUNK_LIMITS,
			maxFrameBytes: maxFrameBytes ?? DEFAULT_CHUNK_LIMITS.maxFrameBytes,
			maxReassembledFrameBytes: maxReassembledFrameBytes ?? DEFAULT_CHUNK_LIMITS.maxReassembledFrameBytes,
		});
		this.#ready.resolve(frame);
	}

	#handleResponse(frame: ResponseFrame): void {
		if (frame.id === undefined) {
			this.#logger.warn(`OMP ${frame.command} failure without request id: ${frame.error ?? "unknown error"}`);
			return;
		}
		const pending = this.#pending.get(frame.id);
		if (!pending) {
			this.#logger.debug(`Late or unknown OMP response ${frame.id} (${frame.command}) ignored`);
			return;
		}
		this.#pending.delete(frame.id);
		clearTimeout(pending.timer);
		if (frame.success) pending.resolve(frame.data);
		else pending.reject(new OmpRequestError(frame.error ?? `${frame.command} failed`, frame.command, frame.code));
	}

	#handleClose(close: TransportClose): void {
		if (this.#closed) return;
		this.#decoder.end();
		this.#closed = close;
		const reason = closeSummary(close);
		this.#ready.reject(new Error(`${reason} before it was ready`));
		this.#rejectAll(reason, "closed");
		this.#close.fire(close);
	}

	#rejectAll(reason: string, code: string): void {
		for (const [id, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.reject(new OmpRequestError(`${reason}; ${pending.command} did not complete`, pending.command, code));
			this.#pending.delete(id);
		}
	}
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
