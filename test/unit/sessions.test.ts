import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listSessions } from "../../src/omp/sessions";

describe("listSessions", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	function write(name: string, lines: unknown[], mtime: number): string {
		const file = path.join(dir, name);
		fs.writeFileSync(file, lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
		fs.utimesSync(file, mtime, mtime);
		return file;
	}

	it("reads header, title and first user message, newest first", async () => {
		const older = write(
			"a.jsonl",
			[
				{ type: "title", v: 1, title: "", pad: "   " },
				{ type: "session", version: 3, id: "s-a", cwd: "/w", timestamp: "2026-01-01T00:00:00Z" },
				{ type: "model_change", id: "x" },
				{ type: "message", message: { role: "assistant", content: [] } },
				{ type: "message", message: { role: "user", content: [{ type: "text", text: "first question" }] } },
				{ type: "message", message: { role: "user", content: "second" } },
			],
			1000,
		);
		const newer = write(
			"b.jsonl",
			[
				{ type: "title", v: 1, title: "Named session" },
				{ type: "session", id: "s-b", cwd: "/w", timestamp: "2026-01-02T00:00:00Z" },
				{ type: "message", message: { role: "user", content: "hello" } },
			],
			2000,
		);
		const sessions = await listSessions(dir);
		assert.deepEqual(
			sessions.map(s => [s.path, s.id, s.title, s.firstMessage, s.cwd, s.modified]),
			[
				[newer, "s-b", "Named session", "hello", "/w", 2000_000],
				[older, "s-a", undefined, "first question", "/w", 1000_000],
			],
		);
		assert.ok(sessions[0].size > 0);
	});

	it("skips garbage files, non-jsonl files and malformed lines", async () => {
		write("garbage.jsonl", ["not json at all", "{\"type\":"], 3000);
		write("notes.txt", [{ type: "session", id: "nope" }], 3000);
		const ok = write("ok.jsonl", ["{broken", { type: "session", id: "s-ok" }], 1000);
		fs.mkdirSync(path.join(dir, "dir.jsonl"));
		const sessions = await listSessions(dir);
		assert.deepEqual(sessions.map(s => s.path), [ok]);
	});

	it("reads only the first 64 KiB of each file", async () => {
		const big = "x".repeat(70 * 1024);
		write("big.jsonl", [{ type: "session", id: "s-big" }, { type: "custom", pad: big }, { type: "message", message: { role: "user", content: "late" } }], 1000);
		const [session] = await listSessions(dir);
		assert.equal(session.id, "s-big");
		assert.equal(session.firstMessage, undefined);
	});

	it("returns an empty list for a missing directory", async () => {
		assert.deepEqual(await listSessions(path.join(dir, "missing")), []);
	});
});
