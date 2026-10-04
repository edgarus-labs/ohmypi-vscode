import type { Disposable, Event, Logger } from "./api";
import { Emitter } from "./emitter";
import { ChunkReassembler, DEFAULT_CHUNK_LIMITS, JsonlDecoder } from "./jsonl";
import {
	type CommandMap,
	type CommandOutputFrame,
	type CommandType,
	type ConfigUpdateFrame,
	type ExtensionUiRequest,
	type ExtensionUiResponse,
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
}

/** Byte stream to and from one OMP process (a child process, or in-memory in tests). */
export interface OmpTransport {
	/** Write one JSONL line. Throws when the transport can no longer accept input. */
	write(line: string): void;
	readonly onData: Event<Uint8Array>;
	readonly onClose: Event<TransportClose>;
}

/**
 * A command failed. `code` is OMP's machine-readable code when the server sent
 * one, otherwise `timeout`, `closed` or `write_failed` for local failures.
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
	/** Caller-chosen id, e.g. to correlate a prompt with its `prompt_result`. */
	id?: string;
}

export interface OmpRpcClientOptions {
	logger: Logger;
	/** Emit abbreviated frames through `logger.trace`. */
	trace?: boolean;
	readyTimeoutMs?: number;
	requestTimeoutMs?: number;
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

function abbreviate(frame: unknown): string {
	const json = JSON.stringify(frame, (_key, value: unknown) =>
		typeof value === "string" && value.length > TRACE_STRING_LIMIT
			? `${value.slice(0, TRACE_STRING_LIMIT)}…(${value.length} chars)`
			: value,
	);
	return json.length > TRACE_FRAME_LIMIT ? `${json.slice(0, TRACE_FRAME_LIMIT)}…` : json;
}

function describeClose(close: TransportClose): string {
	if (close.error) return `OMP process failed: ${close.error.message}`;
	return close.signal ? `OMP process exited (signal ${close.signal})` : `OMP process exited (code ${close.code})`;
}

/**
 * Typed OMP RPC client: handshake, request/response correlation and frame
 * dispatch over an {@link OmpTransport}.
 */
export class OmpRpcClient implements Disposable {
	readonly #transport: OmpTransport;
	readonly #logger: Logger;
	readonly #trace: boolean;
	readonly #readyTimeoutMs: number;
	readonly #requestTimeoutMs: number;
	readonly #decoder: JsonlDecoder;
	#reassembler = new ChunkReassembler(DEFAULT_CHUNK_LIMITS);
	readonly #pending = new Map<string, PendingRequest>();
	readonly #ready = Promise.withResolvers<ReadyFrame>();
	readonly #subscriptions: Disposable[];
	#readyFrame: ReadyFrame | undefined;
	#closed: TransportClose | undefined;
	#nextId = 0;
	#protocolVersion = 1;

	readonly #sessionEvent: Emitter<SessionEvent>;
	readonly #promptResult: Emitter<PromptResultFrame>;
	readonly #sessionSettled: Emitter<void>;
	readonly #uiRequest: Emitter<ExtensionUiRequest>;
	readonly #subagentFrame: Emitter<SubagentFrame>;
	readonly #commandOutput: Emitter<CommandOutputFrame>;
	readonly #sessionInfoUpdate: Emitter<SessionInfoUpdateFrame>;
	readonly #configUpdate: Emitter<ConfigUpdateFrame>;
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
	readonly onUnknownFrame: Event<UnknownFrame>;
	/** The transport ended; every pending request has already been rejected. */
	readonly onClose: Event<TransportClose>;

	constructor(transport: OmpTransport, options: OmpRpcClientOptions) {
		this.#transport = transport;
		this.#logger = options.logger;
		this.#trace = options.trace === true;
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
		this.onUnknownFrame = this.#unknownFrame.event;
		this.onClose = this.#close.event;

		this.#decoder = new JsonlDecoder({
			value: value => this.#receive(value),
			error: error => this.#logger.warn(`OMP stdout: ${error.message}`),
		});
		this.#subscriptions = [
			transport.onData(chunk => this.#decoder.push(chunk)),
			transport.onClose(close => this.#handleClose(close)),
		];
	}

	get protocolVersion(): number {
		return this.#protocolVersion;
	}

	get readyFrame(): ReadyFrame | undefined {
		return this.#readyFrame;
	}

	/** Wait for the `ready` frame and negotiate protocol v2 when the server offers it. */
	async start(): Promise<void> {
		const timer = setTimeout(
			() => this.#ready.reject(new Error(`OMP did not send a ready frame within ${this.#readyTimeoutMs} ms`)),
			this.#readyTimeoutMs,
		);
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
			if (error instanceof OmpRequestError && error.code === "closed") throw error;
			this.#logger.warn(`OMP protocol v2 negotiation failed; staying on v1: ${(error as Error).message}`);
		}
	}

	nextId(): string {
		this.#nextId += 1;
		return `req_${this.#nextId}`;
	}

	request<K extends CommandType>(type: K, ...[params, options]: RequestArgs<K>): Promise<CommandMap[K]["result"]> {
		if (this.#closed) {
			return Promise.reject(new OmpRequestError(`${describeClose(this.#closed)}; cannot send ${type}`, type, "closed"));
		}
		const id = options?.id ?? this.nextId();
		const frame = { ...(params ?? {}), id, type };
		const { promise, resolve, reject } = Promise.withResolvers<CommandMap[K]["result"]>();
		const pending: PendingRequest = { command: type, resolve: resolve as (data: unknown) => void, reject };
		const timeoutMs = options?.timeoutMs ?? this.#requestTimeoutMs;
		if (timeoutMs > 0) {
			pending.timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new OmpRequestError(`OMP command ${type} timed out after ${timeoutMs} ms`, type, "timeout"));
			}, timeoutMs);
		}
		this.#pending.set(id, pending);
		try {
			this.#write(frame);
		} catch (error) {
			clearTimeout(pending.timer);
			this.#pending.delete(id);
			reject(new OmpRequestError(`Failed to send ${type} to OMP: ${(error as Error).message}`, type, "write_failed"));
		}
		return promise;
	}

	/**
	 * Answer an extension UI request. `secret` responses are written verbatim but
	 * never traced.
	 */
	sendUiResponse(response: ExtensionUiResponse, secret = false): void {
		const traced = secret && "value" in response ? { ...response, value: "[redacted]" } : response;
		this.#write(response, traced);
	}

	dispose(): void {
		for (const subscription of this.#subscriptions) subscription.dispose();
		this.#closed ??= { code: null, signal: null, error: new Error("client disposed") };
		this.#rejectAll("OMP client disposed", "closed");
		for (const emitter of [
			this.#sessionEvent,
			this.#promptResult,
			this.#sessionSettled,
			this.#uiRequest,
			this.#subagentFrame,
			this.#commandOutput,
			this.#sessionInfoUpdate,
			this.#configUpdate,
			this.#unknownFrame,
			this.#close,
		])
			emitter.dispose();
	}

	#write(frame: object, traced: object = frame): void {
		const line = `${JSON.stringify(frame)}\n`;
		if (this.#trace) this.#logger.trace("out", abbreviate(traced));
		this.#transport.write(line);
	}

	#receive(value: unknown): void {
		const { frame, error } = this.#reassembler.push(value);
		if (error) this.#logger.warn(`OMP frame rejected: ${error.message}`);
		if (!frame) return;
		if (this.#trace) this.#logger.trace("in", abbreviate(frame));
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
			case "host_tool_call":
				this.#write({
					type: "host_tool_result",
					id: frame.id,
					isError: true,
					result: {
						content: [{ type: "text", text: `Host tool ${String(frame.toolName)} is not provided by this client.` }],
					},
				});
				return;
			case "host_uri_request":
				this.#write({
					type: "host_uri_result",
					id: frame.id,
					isError: true,
					error: `URL ${String(frame.url)} is not served by this client.`,
				});
				return;
			case "host_tool_cancel":
			case "host_uri_cancel":
			case "available_commands_update":
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
		this.#readyFrame = frame;
		this.#reassembler = new ChunkReassembler({
			maxFrameBytes: frame.maxFrameBytes ?? DEFAULT_CHUNK_LIMITS.maxFrameBytes,
			maxReassembledFrameBytes: frame.maxReassembledFrameBytes ?? DEFAULT_CHUNK_LIMITS.maxReassembledFrameBytes,
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
		const reason = describeClose(close);
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
