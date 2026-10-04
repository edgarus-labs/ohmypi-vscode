import * as assert from "node:assert/strict";
import type { PromptOutcome, SessionPhase } from "../../src/omp/api";
import { PromptTracker } from "../../src/omp/phase";
import type { PromptResultFrame } from "../../src/omp/protocol";
import { tick } from "./helpers";

function tracker() {
	const phases: SessionPhase[] = [];
	const t = new PromptTracker(phase => phases.push(phase));
	return { t, phases };
}

function settledState<T>(promise: Promise<T>) {
	const state: { value?: T } = {};
	promise.then(value => {
		state.value = value;
	});
	return state;
}

const result = (id: string, extra: Partial<Omit<PromptResultFrame, "type" | "id">> = {}): PromptResultFrame => ({
	type: "prompt_result",
	id,
	agentInvoked: true,
	status: "completed",
	sessionSettled: true,
	...extra,
});

describe("PromptTracker phases", () => {
	it("treats the prompt ack as admission, not completion", async () => {
		const { t, phases } = tracker();
		const outcome = settledState(t.submit("p1"));
		assert.equal(t.phase, "submitting");
		t.acknowledged("p1", undefined);
		assert.equal(t.phase, "running");
		t.agentStart();
		t.agentEnd(true);
		await tick();
		assert.equal(outcome.value, undefined, "not resolved before prompt_result");
		t.promptResult(result("p1"));
		await tick();
		assert.deepEqual(outcome.value, { status: "completed", sessionSettled: true } satisfies PromptOutcome);
		assert.equal(t.phase, "idle");
		assert.deepEqual(phases, ["submitting", "running", "idle"]);
	});

	it("goes yielded on prompt_result with sessionSettled=false and idle on session_settled", async () => {
		const { t } = tracker();
		const outcome = t.submit("p1");
		t.acknowledged("p1", true);
		t.agentStart();
		t.agentEnd(true);
		t.promptResult(result("p1", { sessionSettled: false }));
		assert.deepEqual(await outcome, { status: "completed", sessionSettled: false });
		assert.equal(t.phase, "yielded");
		t.agentStart();
		assert.equal(t.phase, "running", "background work woke the agent");
		t.agentEnd(true);
		assert.equal(t.phase, "yielded");
		t.sessionSettled();
		assert.equal(t.phase, "idle");
	});

	it("keeps running through a non-yielded agent_end", () => {
		const { t } = tracker();
		t.submit("p1");
		t.acknowledged("p1", true);
		t.agentStart();
		t.agentEnd(false);
		assert.equal(t.phase, "running");
	});

	it("completes locally when the ack says agentInvoked=false", async () => {
		const { t } = tracker();
		const outcome = t.submit("p1");
		t.acknowledged("p1", false);
		assert.deepEqual(await outcome, { status: "local", sessionSettled: true });
		assert.equal(t.phase, "idle");
	});

	it("resolves error when the prompt command fails", async () => {
		const { t } = tracker();
		const outcome = t.submit("p1");
		t.rejected("p1", "No model selected");
		assert.deepEqual(await outcome, { status: "error", error: "No model selected", sessionSettled: true });
		assert.equal(t.phase, "idle");
	});

	it("enters aborting on abort and resolves the prompt as aborted", async () => {
		const { t } = tracker();
		const outcome = t.submit("p1");
		t.acknowledged("p1", true);
		t.agentStart();
		t.abortRequested();
		assert.equal(t.phase, "aborting");
		t.agentStart();
		assert.equal(t.phase, "aborting", "stays aborting until the run ends");
		t.agentEnd(true);
		t.promptResult(result("p1", { status: "aborted" }));
		assert.deepEqual(await outcome, { status: "aborted", sessionSettled: true });
		assert.equal(t.phase, "idle");
	});

	it("ignores abort while idle", () => {
		const { t, phases } = tracker();
		t.abortRequested();
		assert.equal(t.phase, "idle");
		assert.deepEqual(phases, []);
	});

	it("carries the prompt_result error message", async () => {
		const { t } = tracker();
		const outcome = t.submit("p1");
		t.acknowledged("p1", true);
		t.promptResult({ ...result("p1", { status: "error" }), error: { message: "rate limited", retryable: true } });
		assert.deepEqual(await outcome, { status: "error", error: "rate limited", sessionSettled: true });
	});

	it("only completes the prompt matching the prompt_result id", async () => {
		const { t } = tracker();
		const first = settledState(t.submit("p1"));
		const second = settledState(t.submit("p2"));
		t.acknowledged("p1", true);
		t.acknowledged("p2", true);
		t.promptResult(result("p2", { sessionSettled: false }));
		await tick();
		assert.equal(first.value, undefined);
		assert.equal(second.value?.status, "completed");
		assert.equal(t.phase, "running", "p1 is still outstanding");
	});

	it("resolves every pending prompt with error when the process terminates", async () => {
		const { t } = tracker();
		const a = t.submit("p1");
		const b = t.submit("p2");
		t.acknowledged("p1", true);
		t.terminate("OMP process exited (code 3)");
		assert.deepEqual(await a, { status: "error", error: "OMP process exited (code 3)", sessionSettled: true });
		assert.equal((await b).status, "error");
		assert.equal(t.phase, "idle");
	});

	it("tracks agent runs started without a prompt", () => {
		const { t } = tracker();
		t.agentStart();
		assert.equal(t.phase, "running");
		t.agentEnd(true);
		assert.equal(t.phase, "yielded");
		t.sessionSettled();
		assert.equal(t.phase, "idle");
	});
});
