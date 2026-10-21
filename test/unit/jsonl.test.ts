import * as assert from "node:assert/strict";
import { ChunkReassembler, JsonlDecoder } from "../../src/omp/jsonl";
import { isRecord } from "../../src/shared/guards";

function collect() {
	const values: unknown[] = [];
	const errors: Error[] = [];
	const decoder = new JsonlDecoder({ value: v => values.push(v), error: e => errors.push(e) });
	return { decoder, values, errors };
}

describe("JsonlDecoder", () => {
	it("decodes objects split across arbitrary chunk boundaries", () => {
		const { decoder, values } = collect();
		const text = '{"a":1}\n{"b":"two"}\n{"c":[3]}\n';
		const bytes = Buffer.from(text);
		for (let i = 0; i < bytes.length; i += 3) decoder.push(bytes.subarray(i, i + 3));
		assert.deepEqual(values, [{ a: 1 }, { b: "two" }, { c: [3] }]);
	});

	it("reassembles multibyte UTF-8 characters split between chunks", () => {
		const { decoder, values, errors } = collect();
		const bytes = Buffer.from('{"t":"zażółć 😀"}\n');
		for (let i = 0; i < bytes.length; i++) decoder.push(bytes.subarray(i, i + 1));
		assert.deepEqual(errors, []);
		assert.deepEqual(values, [{ t: "zażółć 😀" }]);
	});

	it("accepts CRLF line endings and skips blank lines", () => {
		const { decoder, values, errors } = collect();
		decoder.push(Buffer.from('{"a":1}\r\n\r\n   \n{"b":2}\r\n'));
		assert.deepEqual(errors, []);
		assert.deepEqual(values, [{ a: 1 }, { b: 2 }]);
	});

	it("reports a malformed line and keeps decoding", () => {
		const { decoder, values, errors } = collect();
		decoder.push(Buffer.from('{"a":1}\n{not json\n{"b":2}\n'));
		assert.deepEqual(values, [{ a: 1 }, { b: 2 }]);
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /malformed/i);
	});

	it("reports invalid UTF-8 as an error instead of substituting characters", () => {
		const { decoder, values, errors } = collect();
		decoder.push(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]));
		decoder.push(Buffer.from('{"ok":true}\n'));
		assert.deepEqual(values, [{ ok: true }]);
		assert.equal(errors.length, 1);
	});

	it("flushes a final unterminated line on end()", () => {
		const { decoder, values } = collect();
		decoder.push(Buffer.from('{"a":1}'));
		assert.deepEqual(values, []);
		decoder.end();
		assert.deepEqual(values, [{ a: 1 }]);
	});

	it("drops an over-long line with an error and resumes at the next line", () => {
		const values: unknown[] = [];
		const errors: Error[] = [];
		const decoder = new JsonlDecoder({ value: v => values.push(v), error: e => errors.push(e) }, 16);
		decoder.push(Buffer.from('{"long":"aaaaaaaa'));
		decoder.push(Buffer.from('aaaaaaaaaaaaaaa"}\n{"b":2}\n'));
		assert.deepEqual(values, [{ b: 2 }]);
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /exceeds/);
	});

	it("accepts a line of exactly maxLineBytes and drops one byte more", () => {
		const values: unknown[] = [];
		const errors: Error[] = [];
		const decoder = new JsonlDecoder({ value: v => values.push(v), error: e => errors.push(e) }, 16);
		decoder.push(Buffer.from(`{"a":"${"x".repeat(8)}"}\n`));
		decoder.push(Buffer.from(`{"a":"${"x".repeat(9)}"}\n`));
		assert.deepEqual(values, [{ a: "x".repeat(8) }]);
		assert.equal(errors.length, 1);
	});

	it("forgets a line being dropped when end() is called", () => {
		const values: unknown[] = [];
		const errors: Error[] = [];
		const decoder = new JsonlDecoder({ value: v => values.push(v), error: e => errors.push(e) }, 16);
		decoder.push(Buffer.from('{"long":"aaaaaaaaaaaaaaaaaaaa'));
		decoder.end();
		decoder.push(Buffer.from('{"b":2}\n'));
		assert.deepEqual(values, [{ b: 2 }]);
		assert.equal(errors.length, 1);
	});

	it("reports a value handler failure and keeps decoding the rest of the chunk", () => {
		const values: unknown[] = [];
		const errors: Error[] = [];
		const decoder = new JsonlDecoder({
			value: v => {
				if (isRecord(v) && v.a === 1) throw new Error("listener broke");
				values.push(v);
			},
			error: e => errors.push(e),
		});
		decoder.push(Buffer.from('{"a":1}\n{"b":2}\n{"c":'));
		decoder.push(Buffer.from("3}\n"));
		assert.deepEqual(values, [{ b: 2 }, { c: 3 }]);
		assert.equal(errors.length, 1);
		assert.match(errors[0].message, /listener broke/);
	});
});

const LIMITS = { maxFrameBytes: 16, maxReassembledFrameBytes: 1024, maxChunkPayloadBytes: 16 };

function chunkFrames(frame: object, size: number, chunkId = "rpc-1") {
	const bytes = Buffer.from(JSON.stringify(frame));
	const count = Math.ceil(bytes.length / size);
	return Array.from({ length: count }, (_, index) => ({
		type: "rpc_chunk",
		chunkId,
		index,
		count,
		byteLength: bytes.length,
		data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
	}));
}

describe("ChunkReassembler", () => {
	it("passes ordinary frames through", () => {
		const r = new ChunkReassembler(LIMITS);
		assert.deepEqual(r.push({ type: "agent_start" }), { frame: { type: "agent_start" } });
	});

	it("reassembles a valid chunk sequence including split multibyte characters", () => {
		const r = new ChunkReassembler(LIMITS);
		const frame = { type: "response", id: "x", data: "ąćęłńóśźż 😀 long enough" };
		const chunks = chunkFrames(frame, 7);
		const results = chunks.map(c => r.push(c));
		assert.deepEqual(
			results.slice(0, -1),
			chunks.slice(0, -1).map(() => ({})),
		);
		assert.deepEqual(results.at(-1), { frame });
	});

	it("rejects invalid metadata", () => {
		const r = new ChunkReassembler(LIMITS);
		const [first] = chunkFrames({ type: "x", pad: "0123456789abcdef" }, 8);
		assert.ok(r.push({ ...first, chunkId: "" }).error);
		assert.ok(r.push({ ...first, index: -1 }).error);
		assert.ok(r.push({ ...first, count: 1 }).error);
		assert.ok(r.push({ ...first, index: first.count }).error);
		assert.ok(r.push({ ...first, byteLength: 4 }).error, "byteLength below the frame limit");
		assert.ok(r.push({ ...first, byteLength: 4096 }).error, "byteLength above the reassembly limit");
		assert.ok(r.push({ ...first, data: "@@@" }).error, "invalid base64");
	});

	it("rejects a sequence that does not start at index 0", () => {
		const r = new ChunkReassembler(LIMITS);
		const chunks = chunkFrames({ type: "x", pad: "0123456789abcdef" }, 8);
		assert.match(r.push(chunks[1]).error!.message, /index 0/);
	});

	it("rejects interleaved sequences and recovers for the next one", () => {
		const r = new ChunkReassembler(LIMITS);
		const a = chunkFrames({ type: "a", pad: "0123456789abcdef" }, 8, "a");
		const b = chunkFrames({ type: "b", pad: "0123456789abcdef" }, 8, "b");
		assert.deepEqual(r.push(a[0]), {});
		assert.match(r.push(b[0]).error!.message, /mismatch/);
		const results = b.map(c => r.push(c));
		assert.deepEqual(results.at(-1), { frame: { type: "b", pad: "0123456789abcdef" } });
	});

	it("reports an interrupted sequence but still delivers the interrupting frame", () => {
		const r = new ChunkReassembler(LIMITS);
		const a = chunkFrames({ type: "a", pad: "0123456789abcdef" }, 8);
		r.push(a[0]);
		const result = r.push({ type: "agent_start" });
		assert.match(result.error!.message, /interrupted/);
		assert.deepEqual(result.frame, { type: "agent_start" });
	});

	it("rejects a byte length mismatch", () => {
		const r = new ChunkReassembler(LIMITS);
		const chunks = chunkFrames({ type: "a", pad: "0123456789abcdef" }, 8).map(c => ({ ...c, byteLength: c.byteLength + 1 }));
		const results = chunks.map(c => r.push(c));
		assert.match(results.at(-1)!.error!.message, /length/);
	});

	it("rejects reassembled payloads that are not a JSON object", () => {
		const r = new ChunkReassembler(LIMITS);
		const bytes = Buffer.from('"just a long string value"');
		const chunks = [0, 1].map(index => ({
			type: "rpc_chunk",
			chunkId: "s",
			index,
			count: 2,
			byteLength: bytes.length,
			data: bytes.subarray(index * 13, (index + 1) * 13).toString("base64"),
		}));
		const results = chunks.map(c => r.push(c));
		assert.ok(results[1].error);
	});

	it("rejects more chunks than the reassembly limit allows at the largest chunk payload", () => {
		const r = new ChunkReassembler(LIMITS);
		const [first] = chunkFrames({ type: "x", pad: "0123456789abcdef" }, 8);
		assert.deepEqual(r.push({ ...first, count: 64 }), {});
		assert.match(new ChunkReassembler(LIMITS).push({ ...first, count: 65 }).error!.message, /metadata/);
	});

	it("rejects a chunk payload above the chunk payload limit even within the frame limit", () => {
		const r = new ChunkReassembler({ maxFrameBytes: 64, maxReassembledFrameBytes: 1024, maxChunkPayloadBytes: 16 });
		const [first] = chunkFrames({ type: "x", pad: "0123456789abcdef".repeat(8) }, 17);
		assert.match(r.push(first).error!.message, /payload/);
	});

	it("rejects base64 that is not in canonical form", () => {
		const r = new ChunkReassembler(LIMITS);
		const [first] = chunkFrames({ type: "x", pad: "0123456789abcdef" }, 7);
		const canonical = first.data;
		assert.ok(canonical.endsWith("=="), "the fixture chunk ends in one byte of a final group");
		assert.deepEqual(new ChunkReassembler(LIMITS).push(first), {});
		assert.ok(r.push({ ...first, data: canonical.replace(/=+$/, "") }).error, "missing padding");
		assert.ok(
			r.push({ ...first, data: `${canonical.slice(0, -3)}${String.fromCharCode(canonical.charCodeAt(canonical.length - 3) + 1)}==` }).error,
			"non-zero trailing bits",
		);
		assert.ok(r.push({ ...first, data: canonical.replace(/\+/g, "-").replace(/\//g, "_").replace(/^(.)/, "-") }).error, "URL-safe alphabet");
		assert.ok(r.push({ ...first, data: ` ${canonical}` }).error, "whitespace");
	});

	it("accepts a chunk whose base64 text is several megabytes long", () => {
		const payload = 3.5 * 1024 * 1024;
		const r = new ChunkReassembler({ maxFrameBytes: 8 * 1024 * 1024, maxReassembledFrameBytes: 64 * 1024 * 1024, maxChunkPayloadBytes: payload });
		const frame = { type: "big", pad: "z".repeat(8 * 1024 * 1024) };
		const results = chunkFrames(frame, payload).map(c => r.push(c));
		assert.deepEqual(results.at(-1), { frame });
	});
});
