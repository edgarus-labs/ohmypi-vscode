import { errorMessage } from "../shared/errors";
import { isRecord } from "../shared/guards";

const NEWLINE = 0x0a;
/** Line ceiling until the server advertises its frame limit, and for servers that never do. */
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export interface JsonlHandlers {
	/** A decoded line; an exception thrown here is reported through `error` and decoding continues. */
	value(value: unknown): void;
	/** A line could not be decoded; decoding continues with the next line. */
	error(error: Error): void;
}

/**
 * Incremental newline-delimited JSON decoder. Lines are split on raw bytes, so
 * multibyte UTF-8 sequences may straddle chunk boundaries.
 */
export class JsonlDecoder {
	#pending: Buffer[] = [];
	#pendingBytes = 0;
	#discarding = false;
	readonly #utf8 = new TextDecoder("utf-8", { fatal: true });
	/** Longest accepted line in bytes; longer lines are reported and dropped. */
	maxLineBytes: number;

	constructor(
		private readonly handlers: JsonlHandlers,
		maxLineBytes = DEFAULT_MAX_LINE_BYTES,
	) {
		this.maxLineBytes = maxLineBytes;
	}

	push(chunk: Uint8Array): void {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		let start = 0;
		while (start < bytes.length) {
			const newline = bytes.indexOf(NEWLINE, start);
			if (newline === -1) {
				this.#append(bytes.subarray(start));
				return;
			}
			this.#append(bytes.subarray(start, newline));
			this.#completeLine();
			start = newline + 1;
		}
	}

	/** Decode a trailing line that was not newline-terminated. */
	end(): void {
		if (this.#discarding) {
			this.#discarding = false;
			return;
		}
		if (this.#pendingBytes > 0) this.#completeLine();
	}

	#append(part: Buffer): void {
		if (this.#discarding || part.length === 0) return;
		if (this.#pendingBytes + part.length > this.maxLineBytes) {
			this.#pending = [];
			this.#pendingBytes = 0;
			this.#discarding = true;
			this.handlers.error(new Error(`JSONL line exceeds ${this.maxLineBytes} bytes; line dropped`));
			return;
		}
		this.#pending.push(part);
		this.#pendingBytes += part.length;
	}

	#completeLine(): void {
		if (this.#discarding) {
			this.#discarding = false;
			return;
		}
		const line = this.#pending.length === 1 ? this.#pending[0] : Buffer.concat(this.#pending, this.#pendingBytes);
		this.#pending = [];
		this.#pendingBytes = 0;
		this.#decode(line);
	}

	#decode(line: Buffer): void {
		let text: string;
		try {
			text = this.#utf8.decode(line);
		} catch {
			this.handlers.error(new Error("Malformed JSONL line: invalid UTF-8"));
			return;
		}
		if (text.trim() === "") return;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
			this.handlers.error(new Error(`Malformed JSONL line (${(error as Error).message}): ${preview}`));
			return;
		}
		try {
			this.handlers.value(value);
		} catch (error) {
			this.handlers.error(new Error(`JSONL value handler failed: ${errorMessage(error)}`, { cause: error }));
		}
	}
}

export interface ChunkLimits {
	/** Physical frame ceiling advertised by `ready.maxFrameBytes`. */
	maxFrameBytes: number;
	/** Logical frame ceiling advertised by `ready.maxReassembledFrameBytes`. */
	maxReassembledFrameBytes: number;
	/**
	 * Largest decoded payload of one `rpc_chunk`. OMP splits frames into 256 KiB
	 * payloads without advertising the size; it also bounds the chunk count to
	 * `ceil(maxReassembledFrameBytes / maxChunkPayloadBytes)`.
	 */
	maxChunkPayloadBytes: number;
}

export const DEFAULT_CHUNK_LIMITS: ChunkLimits = {
	maxFrameBytes: 1024 * 1024,
	maxReassembledFrameBytes: 64 * 1024 * 1024,
	maxChunkPayloadBytes: 256 * 1024,
};

interface PendingChunks {
	chunkId: string;
	count: number;
	byteLength: number;
	nextIndex: number;
	parts: Buffer[];
	receivedBytes: number;
}

export interface ReassemblyResult {
	/** A complete logical frame ready for dispatch. */
	frame?: Record<string, unknown>;
	/** The chunk (or the sequence it belonged to) was rejected. */
	error?: Error;
}

/**
 * Protocol v2 `rpc_chunk` reassembler applying the chunk checks of OMP's
 * `RpcFrameDecoder`. Unlike OMP, which fails on a chunk sequence interrupted by
 * another frame, it drops the sequence, delivers the interrupting frame and
 * reports the error. Any rejected sequence is dropped and decoding continues.
 */
export class ChunkReassembler {
	#pending: PendingChunks | undefined;

	constructor(private readonly limits: ChunkLimits = DEFAULT_CHUNK_LIMITS) {}

	push(value: unknown): ReassemblyResult {
		if (!isRecord(value)) return { error: new Error("RPC frame must be a JSON object") };
		if (value.type !== "rpc_chunk") {
			if (this.#pending) {
				this.#pending = undefined;
				return { frame: value, error: new Error("RPC chunk sequence interrupted by another frame") };
			}
			return { frame: value };
		}
		try {
			return this.#pushChunk(value);
		} catch (error) {
			this.#pending = undefined;
			return { error: error as Error };
		}
	}

	#pushChunk(value: Record<string, unknown>): ReassemblyResult {
		const { chunkId, index, count, byteLength } = value;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength)
		)
			throw new Error("Invalid RPC chunk metadata");
		const i = index as number;
		const n = count as number;
		const length = byteLength as number;
		const { maxFrameBytes, maxReassembledFrameBytes, maxChunkPayloadBytes } = this.limits;
		if (
			i < 0 ||
			n < 2 ||
			n > Math.ceil(maxReassembledFrameBytes / maxChunkPayloadBytes) ||
			i >= n ||
			length < maxFrameBytes ||
			length > maxReassembledFrameBytes
		)
			throw new Error("Invalid RPC chunk metadata");
		const maxPayload = Math.min(maxFrameBytes, maxChunkPayloadBytes);
		const data = value.data;
		if (typeof data !== "string" || data.length === 0) throw new Error("Invalid RPC chunk data");
		if (data.length > Math.ceil(maxPayload / 3) * 4) throw new Error("RPC chunk payload exceeds the transport limit");
		const bytes = Buffer.from(data, "base64");
		// Node skips characters outside the alphabet and tolerates missing padding; only canonical text survives the round trip.
		if (bytes.toString("base64") !== data) throw new Error("Invalid RPC chunk data");
		if (bytes.length > maxPayload) throw new Error("RPC chunk payload exceeds the transport limit");

		if (!this.#pending) {
			if (i !== 0) throw new Error("RPC chunk sequence must start at index 0");
			this.#pending = { chunkId, count: n, byteLength: length, nextIndex: 0, parts: [], receivedBytes: 0 };
		}
		const pending = this.#pending;
		if (pending.chunkId !== chunkId || pending.count !== n || pending.byteLength !== length || pending.nextIndex !== i)
			throw new Error("RPC chunk sequence mismatch");
		pending.parts.push(bytes);
		pending.receivedBytes += bytes.length;
		pending.nextIndex++;
		if (pending.receivedBytes > pending.byteLength) throw new Error("RPC chunk sequence exceeds its declared length");
		if (pending.nextIndex < pending.count) return {};
		if (pending.receivedBytes !== pending.byteLength) throw new Error("RPC chunk sequence length mismatch");
		this.#pending = undefined;

		const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.parts, pending.receivedBytes));
		const frame: unknown = JSON.parse(text);
		if (!isRecord(frame)) throw new Error("Reassembled RPC frame must be a JSON object");
		return { frame };
	}
}
