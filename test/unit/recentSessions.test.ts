import * as assert from "node:assert/strict";
import * as path from "node:path";
import type { SessionSummary } from "../../src/omp/api";
import { recentSessions } from "../../src/ui/recentSessions";

const dir = path.join(path.sep, "sessions");
const summary = (name: string, modified: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
	path: path.join(dir, `${name}.jsonl`),
	modified,
	size: 10,
	...extra,
});

describe("recentSessions", () => {
	it("titles rows by title, else the first message on one line, else the file name", () => {
		const { sessions } = recentSessions(
			[
				summary("a", 4, { title: "Named", firstMessage: "ignored" }),
				summary("b", 3, { firstMessage: "  fix the\n\tparser   bug \n" }),
				summary("c", 2),
				summary("d", 1, { title: "  ", firstMessage: " \n " }),
			],
			undefined,
		);
		assert.deepEqual(sessions, [
			{ path: path.join(dir, "a.jsonl"), title: "Named", modified: 4 },
			{ path: path.join(dir, "b.jsonl"), title: "fix the parser bug", modified: 3 },
			{ path: path.join(dir, "c.jsonl"), title: "c", modified: 2 },
			{ path: path.join(dir, "d.jsonl"), title: "d", modified: 1 },
		]);
	});

	it("excludes the current session, keeps the newest five and counts the rest", () => {
		const all = Array.from({ length: 8 }, (_, i) => summary(`s${i}`, 100 - i));
		const { sessions, total } = recentSessions(all, all[1].path);
		assert.deepEqual(
			sessions.map(s => s.title),
			["s0", "s2", "s3", "s4", "s5"],
		);
		assert.equal(total, 7);
	});

	it("returns nothing for no saved sessions", () => {
		assert.deepEqual(recentSessions([], "/x.jsonl"), { sessions: [], total: 0 });
	});
});
