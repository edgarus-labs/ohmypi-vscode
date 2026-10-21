import * as assert from "node:assert/strict";
import { DebugSessions } from "../../src/vscode/hostTools/debugSessions";
import { tick } from "./helpers";

interface FakeSession {
	readonly id: string;
	readonly name: string;
}

const stopped = (threadId: number, reason = "breakpoint", text?: string) => ({ type: "event", event: "stopped", body: { reason, threadId, text } });

describe("debug session tracking", () => {
	const main: FakeSession = { id: "s1", name: "Launch app" };
	const child: FakeSession = { id: "s2", name: "Worker" };
	let sessions: DebugSessions<FakeSession>;
	const signal = () => new AbortController().signal;

	beforeEach(() => {
		sessions = new DebugSessions<FakeSession>();
		sessions.track(main);
		sessions.track(child);
	});

	it("knows which sessions are stopped and forgets a stop once the session continues", () => {
		sessions.onMessage("s1", stopped(7, "exception", "TypeError: x is undefined"));
		assert.deepEqual(sessions.stopped(), [{ session: main, stop: { threadId: 7, reason: "exception", text: "TypeError: x is undefined" } }]);
		sessions.onMessage("s1", { type: "event", event: "continued", body: { threadId: 7 } });
		assert.deepEqual(sessions.stopped(), []);
	});

	it("keeps the stop when only another thread continues", () => {
		sessions.onMessage("s1", stopped(7));
		sessions.onMessage("s1", { type: "event", event: "continued", body: { threadId: 8 } });
		assert.equal(sessions.stopped().length, 1);
		sessions.onMessage("s1", { type: "event", event: "continued", body: { threadId: 8, allThreadsContinued: true } });
		assert.deepEqual(sessions.stopped(), []);
	});

	it("forgets the stop when VS Code resumes the session itself", () => {
		sessions.onMessage("s1", stopped(7));
		sessions.onClientMessage("s1", { type: "request", seq: 9, command: "evaluate", arguments: { expression: "x" } });
		assert.equal(sessions.stopped().length, 1);
		sessions.onClientMessage("s1", { type: "request", seq: 10, command: "next", arguments: { threadId: 7 } });
		assert.deepEqual(sessions.stopped(), []);
	});

	it("resolves with the stop the action causes, even one reported before the action returns", async () => {
		sessions.onMessage("s1", stopped(1));
		const outcome = await sessions.waitAfter(async () => sessions.onMessage("s1", stopped(1, "step")), 1000, signal(), "s1");
		assert.deepEqual(outcome, { kind: "stopped", session: main, stop: { threadId: 1, reason: "step" } });
	});

	it("forgets the old stop of the resumed session before acting", async () => {
		sessions.onMessage("s1", stopped(1));
		const outcome = sessions.waitAfter(async () => undefined, 1000, signal(), "s1");
		assert.deepEqual(sessions.stopped(), []);
		sessions.onMessage("s2", stopped(4));
		assert.deepEqual(await outcome, { kind: "stopped", session: child, stop: { threadId: 4, reason: "breakpoint" } });
	});

	it("resolves ended when the resumed session terminates", async () => {
		const outcome = sessions.waitAfter(async () => undefined, 1000, signal(), "s1");
		await tick();
		sessions.onMessage("s1", { type: "event", event: "terminated" });
		assert.deepEqual(await outcome, { kind: "ended" });
		assert.deepEqual(sessions.stopped(), []);
	});

	it("resolves ended when the debug adapter exits", async () => {
		const outcome = sessions.waitAfter(async () => undefined, 1000, signal(), "s1");
		await tick();
		sessions.onEnded("s1");
		assert.deepEqual(await outcome, { kind: "ended" });
	});

	it("ignores the end of another session while waiting on one", async () => {
		const outcome = sessions.waitAfter(async () => undefined, 30, signal(), "s1");
		await tick();
		sessions.onEnded("s2");
		assert.deepEqual(await outcome, { kind: "running" });
	});

	it("counts the wait from the end of the action and reports running when nothing stops in time", async () => {
		const started = Date.now();
		const outcome = await sessions.waitAfter(() => tick(40), 20, signal());
		assert.deepEqual(outcome, { kind: "running" });
		assert.ok(Date.now() - started >= 55);
	});

	it("rejects when the wait is aborted", async () => {
		const controller = new AbortController();
		const outcome = sessions.waitAfter(async () => undefined, 1000, controller.signal, "s1");
		await tick();
		controller.abort(new Error("cancelled"));
		await assert.rejects(outcome, /cancelled/);
		sessions.onMessage("s1", stopped(2));
	});

	it("rejects with the action's failure", async () => {
		await assert.rejects(
			sessions.waitAfter(() => Promise.reject(new Error("not stopped")), 1000, signal(), "s1"),
			/not stopped/,
		);
	});

	it("resolves the end wait once every tracked session and every listed one ended, ignoring stops", async () => {
		let settled = false;
		const ended = sessions
			.endAfter(async () => sessions.onEnded("s1"), 1000, signal(), ["s3"])
			.then(value => {
				settled = true;
				return value;
			});
		await tick();
		sessions.onMessage("s2", stopped(4));
		sessions.onEnded("s2");
		await tick();
		assert.equal(settled, false);
		sessions.onEnded("s3");
		assert.equal(await ended, true);
	});

	it("resolves the end wait false when a session still runs after the wait", async () => {
		assert.equal(await sessions.endAfter(async () => sessions.onEnded("s1"), 20, signal()), false);
	});

	it("resolves the end wait right after the action when no session runs", async () => {
		const idle = new DebugSessions<FakeSession>();
		const ended = idle.endAfter(async () => undefined, 60_000, signal());
		assert.equal(await Promise.race([ended, tick(50).then(() => "still waiting")]), true);
	});

	it("rejects the end wait when it is aborted", async () => {
		const controller = new AbortController();
		const ended = sessions.endAfter(async () => undefined, 1000, controller.signal);
		await tick();
		controller.abort(new Error("cancelled"));
		await assert.rejects(ended, /cancelled/);
		sessions.onEnded("s1");
		sessions.onEnded("s2");
	});
});
