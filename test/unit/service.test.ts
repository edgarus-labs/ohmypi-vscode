import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ConnectionState,
	InteractionRequest,
	PresentationRequest,
	SessionPhase,
	ToolExecutionEvent,
	TranscriptItem,
} from "../../src/omp/api";
import { OmpService } from "../../src/omp/service";
import { FAKE_OMP, isAlive, memoryLogger, waitFor } from "./helpers";

describe("OmpService against fake-omp", function () {
	this.timeout(20000);
	let dir: string;
	let logFile: string;
	let services: OmpService[] = [];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-service-"));
		logFile = path.join(dir, "commands.log");
	});
	afterEach(async () => {
		for (const service of services) await service.stop();
		services = [];
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function create(options: { autoRestart?: boolean; traceRpc?: boolean; env?: NodeJS.ProcessEnv } = {}) {
		const logger = memoryLogger();
		const service = new OmpService(
			{
				executable: FAKE_OMP,
				extraArgs: [],
				cwd: dir,
				env: { ...process.env, FAKE_OMP_SESSION_DIR: path.join(dir, "sessions"), FAKE_OMP_LOG: logFile, ...options.env },
				logger,
				autoRestart: options.autoRestart ?? false,
				traceRpc: options.traceRpc,
			},
			{ restartDelaysMs: [20, 20, 20], restartWindowMs: 60_000, shutdownGraceMs: 1000 },
		);
		services.push(service);
		const phases: SessionPhase[] = [];
		const states: ConnectionState[] = [];
		const items: TranscriptItem[] = [];
		const tools: ToolExecutionEvent[] = [];
		const interactions: InteractionRequest[] = [];
		const cancelled: string[] = [];
		const presentations: PresentationRequest[] = [];
		service.onDidChangeSession(s => {
			if (phases.at(-1) !== s.phase) phases.push(s.phase);
		});
		service.onDidChangeConnection(c => states.push(c.state));
		service.onDidChangeTranscriptItem(i => items.push(i));
		service.onToolExecution(t => tools.push(t));
		service.onInteractionRequest(r => interactions.push(r));
		service.onInteractionCancelled(id => cancelled.push(id));
		service.onPresentation(p => presentations.push(p));
		return { service, logger, phases, states, items, tools, interactions, cancelled, presentations };
	}

	const sentCommands = () =>
		fs.existsSync(logFile)
			? fs
					.readFileSync(logFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line) as Record<string, unknown>)
			: [];

	const assistantTexts = (service: OmpService) =>
		service.transcript.filter(i => i.kind === "assistant").map(i => (i.kind === "assistant" ? i.text : ""));

	it("starts, configures subscriptions, streams a prompt to settlement and stops without orphans", async () => {
		const { service, phases, states, items } = create();
		await service.start({ newSession: true });
		assert.equal(service.connection.state, "ready");
		assert.equal(service.connection.protocolVersion, 2);
		const pid = service.connection.pid!;
		assert.ok(isAlive(pid));
		assert.ok(service.session.sessionFile?.endsWith(".jsonl"));
		assert.equal(service.session.model?.id, "fake-large");
		assert.deepEqual(service.session.availableThinkingLevels, ["off", "auto", "low", "medium", "high"]);
		assert.deepEqual(service.session.todos, [{ name: "Todos", tasks: [{ content: "Fake task", status: "in_progress" }] }]);
		assert.deepEqual(service.agents.map(a => a.id), ["main"]);

		const commands = sentCommands();
		const byType = (type: string) => commands.find(c => c.type === type);
		assert.equal(byType("set_subagent_subscription")?.level, "progress");
		assert.equal(byType("set_ask_dialog")?.enabled, true);
		assert.deepEqual(byType("set_event_filter"), { ...byType("set_event_filter"), events: null, messageUpdates: "delta" });
		assert.ok(byType("new_session"));

		const outcome = await service.prompt("hello there");
		assert.deepEqual(outcome, { status: "completed", sessionSettled: true });
		assert.equal(service.session.phase, "idle");
		assert.deepEqual(phases.slice(-3), ["submitting", "running", "idle"]);
		assert.ok(items.some(i => i.kind === "assistant" && i.streaming), "saw streaming updates");
		assert.deepEqual(
			service.transcript.map(i => i.kind),
			["user", "assistant"],
		);
		assert.deepEqual(assistantTexts(service), ["Echo: hello there"]);
		assert.ok((service.session.costUsd ?? 0) > 0);

		await service.stop();
		assert.equal(service.connection.state, "stopped");
		assert.ok(states.includes("starting") && states.includes("ready"));
		await waitFor(() => !isAlive(pid), 3000, "omp process gone");
	});

	it("maps models and applies model, thinking level, fast mode and session name", async () => {
		const { service } = create();
		await service.start();
		const models = await service.listModels();
		assert.deepEqual(
			models.map(m => [m.provider, m.id, m.thinkingEfforts]),
			[
				["fake-anthropic", "fake-large", ["low", "medium", "high"]],
				["fake-openai", "fake-small", []],
			],
		);
		await service.setModel("fake-openai", "fake-small");
		assert.equal(service.session.model?.id, "fake-small");
		await waitFor(() => service.agents[0].model === "fake-openai/fake-small", 3000, "main agent model");
		await assert.rejects(service.setModel("nope", "x"), /Model not found/);
		await service.setThinkingLevel("high");
		assert.equal(service.session.thinkingLevel, "high");
		await service.setFastMode(true);
		assert.equal(service.session.fastModeEnabled, true);
		await service.setSessionName("Renamed");
		assert.equal(service.session.sessionName, "Renamed");
	});

	it("reports tool executions with edit details and changes the file", async () => {
		const { service, tools } = create();
		await service.start();
		const target = path.join(dir, "target.ts");
		fs.writeFileSync(target, "const a = 1;\n");
		const outcome = await service.prompt(`please tool ${target}`);
		assert.equal(outcome.status, "completed");
		assert.match(fs.readFileSync(target, "utf8"), /edited by fake-omp/);
		const editEnd = tools.find(t => t.phase === "end" && t.name === "edit")!;
		assert.ok(editEnd);
		assert.deepEqual(
			tools.map(t => `${t.phase}:${t.name}`),
			["start:read", "end:read", "start:edit", "end:edit"],
		);
		const details = editEnd.result!.details as { path: string; oldText: string; newText: string };
		assert.equal(details.path, target);
		assert.equal(details.oldText, "const a = 1;\n");
		assert.match(details.newText, /edited by fake-omp/);
		const toolItems = service.transcript.filter(i => i.kind === "tool");
		assert.deepEqual(
			toolItems.map(i => i.kind === "tool" && i.status),
			["done", "done"],
		);
	});

	it("round-trips a confirm interaction", async () => {
		const { service, interactions } = create();
		await service.start();
		const outcome = service.prompt("approve this");
		await waitFor(() => interactions.length > 0, 5000, "confirm request");
		const request = interactions[0];
		assert.equal(request.kind, "confirm");
		assert.equal(request.kind === "confirm" && request.title, "Approve fake action?");
		service.respondInteraction(request.id, { kind: "confirmed", confirmed: true });
		assert.equal((await outcome).status, "completed");
		assert.deepEqual(assistantTexts(service), ["Decision: Approved"]);
		assert.ok(sentCommands().some(c => c.type === "extension_ui_response" && c.id === request.id && c.confirmed === true));
	});

	it("round-trips an ask interaction with answers", async () => {
		const { service, interactions } = create();
		await service.start();
		const outcome = service.prompt("ask me");
		await waitFor(() => interactions.length > 0, 5000, "ask request");
		const request = interactions[0];
		assert.equal(request.kind, "ask");
		if (request.kind !== "ask") return;
		assert.deepEqual(
			request.questions.map(q => [q.id, q.options.map(o => o.label), q.multi ?? false]),
			[
				["db", ["Postgres", "SQLite"], false],
				["features", ["Auth", "Search"], true],
			],
		);
		service.respondInteraction(request.id, {
			kind: "answers",
			answers: [
				{ id: "db", selectedOptions: [], customInput: "DuckDB" },
				{ id: "features", selectedOptions: ["Auth"] },
			],
		});
		await outcome;
		assert.match(assistantTexts(service)[0], /DuckDB/);
	});

	it("never traces secret input values", async () => {
		const { service, interactions, logger } = create({ traceRpc: true });
		await service.start();
		const outcome = service.prompt("input secret please");
		await waitFor(() => interactions.length > 0, 5000, "input request");
		const request = interactions[0];
		assert.ok(request.kind === "input" && request.secret);
		service.respondInteraction(request.id, { kind: "value", value: "hunter2-token" });
		await outcome;
		assert.deepEqual(assistantTexts(service), ["Received 13 characters"]);
		assert.ok(logger.text("trace").includes("extension_ui_response"));
		assert.ok(!logger.records.some(r => r.message.includes("hunter2-token")));
	});

	it("marks plain input requests as not secret", async () => {
		const { service, interactions } = create();
		await service.start();
		const outcome = service.prompt("input please");
		await waitFor(() => interactions.length > 0, 5000, "input request");
		const request = interactions[0];
		assert.ok(request.kind === "input" && request.secret === false);
		service.respondInteraction(request.id, { kind: "value", value: "abc" });
		await outcome;
		assert.deepEqual(assistantTexts(service), ["Input: abc"]);
	});

	it("aborts a running prompt while a steer is queued", async () => {
		const { service, phases } = create();
		await service.start();
		const outcome = service.prompt("go slow");
		await waitFor(() => service.transcript.some(i => i.kind === "assistant" && i.text.includes("tick")), 5000, "streaming");
		assert.equal(service.session.phase, "running");
		const steer = service.prompt("and more", "auto");
		await waitFor(() => sentCommands().some(c => c.type === "prompt" && c.message === "and more"), 3000, "steer sent");
		assert.equal(sentCommands().find(c => c.message === "and more")?.streamingBehavior, "steer");
		await service.abort();
		assert.deepEqual(await outcome, { status: "aborted", sessionSettled: false });
		assert.equal((await steer).status, "completed");
		await waitFor(() => service.session.phase === "idle", 3000, "idle");
		assert.ok(phases.includes("aborting"));
	});

	it("sends pasted images with the prompt as OMP image content", async () => {
		const { service } = create();
		await service.start();
		const outcome = await service.prompt("what is in this picture", "auto", [{ data: "iVBORw0KGgo=", mimeType: "image/png" }]);
		assert.equal(outcome.status, "completed");
		const sent = sentCommands().find(c => c.type === "prompt" && c.message === "what is in this picture");
		assert.deepEqual(sent?.images, [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
	});

	it("reads OMP's auto effort selector from the session journal and offers auto", async () => {
		const { service } = create({ env: { FAKE_OMP_THINKING: "auto" } });
		await service.start({ newSession: true });
		assert.deepEqual([service.session.thinkingSelector, service.session.thinkingLevel], ["auto", "high"]);
		assert.deepEqual(service.session.availableThinkingLevels, ["off", "auto", "low", "medium", "high"]);
	});

	it("selects auto, keeps it while OMP resolves each turn, and leaves it for an explicit level", async () => {
		const { service } = create();
		await service.start({ newSession: true });
		await service.setThinkingLevel("auto");
		assert.ok(sentCommands().some(c => c.type === "set_thinking_level" && c.level === "auto"));
		assert.equal(service.session.thinkingSelector, "auto");
		await service.prompt("hello");
		assert.deepEqual([service.session.thinkingSelector, service.session.thinkingResolved], ["auto", "low"]);
		await service.setThinkingLevel("medium");
		assert.deepEqual([service.session.thinkingSelector, service.session.thinkingResolved], ["medium", undefined]);
	});

	it("withdraws a pending interaction when OMP cancels it on abort", async () => {
		const { service, interactions, cancelled } = create();
		await service.start();
		const outcome = service.prompt("approve this");
		await waitFor(() => interactions.length > 0, 5000, "confirm request");
		await service.abort();
		assert.equal((await outcome).status, "aborted");
		assert.deepEqual(cancelled, [interactions[0].id]);
		service.respondInteraction(interactions[0].id, { kind: "confirmed", confirmed: true });
		assert.ok(!sentCommands().some(c => c.type === "extension_ui_response"), "withdrawn interaction is not answered");
	});

	it("goes yielded on unsettled prompt_result and idle on session_settled", async () => {
		const { service, phases } = create();
		await service.start();
		const outcome = await service.prompt("run in background");
		assert.deepEqual(outcome, { status: "completed", sessionSettled: false });
		assert.equal(service.session.phase, "yielded");
		await waitFor(() => service.session.phase === "idle", 5000, "settled");
		assert.deepEqual(phases.slice(-4), ["yielded", "running", "yielded", "idle"]);
		assert.deepEqual(assistantTexts(service), ["Started a background job.", "Background job finished."]);
	});

	it("tracks subagents and loads their transcripts", async () => {
		const { service } = create();
		await service.start();
		await service.prompt("spawn subagent work");
		const subs = service.agents.filter(a => a.id !== "main");
		assert.deepEqual(
			subs.map(a => [a.id, a.status, a.parentId, a.toolCount]),
			[
				["Alpha", "completed", "main", 2],
				["Beta", "completed", "main", 2],
			],
		);
		const transcript = await service.getAgentTranscript("Alpha");
		assert.deepEqual(
			transcript.map(i => i.kind),
			["user", "assistant"],
		);
		assert.equal(await service.cancelAgent("Alpha"), false);
		const main = await service.getAgentTranscript("main");
		assert.equal(main.length, service.transcript.length);
	});

	it("resumes a session file and shows its history", async () => {
		const first = create();
		await first.service.start({ newSession: true });
		await first.service.prompt("remember me");
		const file = first.service.session.sessionFile!;
		await first.service.stop();

		const second = create();
		await second.service.start({ resumeSessionFile: file });
		assert.equal(second.service.session.sessionFile, file);
		assert.deepEqual(
			second.service.transcript.map(i => (i.kind === "user" || i.kind === "assistant" ? `${i.kind}:${i.text}` : i.kind)),
			["user:remember me", "assistant:Echo: remember me"],
		);
		const sessions = await second.service.listSessions();
		assert.ok(sessions.some(s => s.path === file && s.firstMessage === "remember me"));

		await second.service.newSession();
		assert.notEqual(second.service.session.sessionFile, file);
		assert.deepEqual(second.service.transcript, []);
		await second.service.switchSession(file);
		assert.equal(second.service.transcript.length, 2);
	});

	it("auto-restarts after a crash, re-binding the session, then gives up after the budget", async () => {
		const { service, states } = create({ autoRestart: true });
		await service.start({ newSession: true });
		const file = service.session.sessionFile!;
		const firstPid = service.connection.pid!;
		const outcome = await service.prompt("please crash");
		assert.equal(outcome.status, "error");
		assert.match(outcome.error!, /exited/);
		await waitFor(() => service.connection.state === "ready" && service.connection.pid !== firstPid, 5000, "restarted");
		assert.ok(states.includes("restarting"));
		assert.equal(isAlive(firstPid), false);
		assert.equal(service.session.sessionFile, file);
		assert.ok(sentCommands().some(c => c.type === "switch_session" && c.sessionPath === file));
		assert.equal(service.session.phase, "idle");

		for (let i = 0; i < 2; i++) {
			const pid = service.connection.pid;
			await service.prompt("crash again");
			await waitFor(() => service.connection.state === "ready" && service.connection.pid !== pid, 5000, `restart ${i + 2}`);
		}
		await service.prompt("crash once more");
		await waitFor(() => service.connection.state === "failed", 5000, "failed");
		assert.match(service.connection.detail!, /restart/i);
		await assert.rejects(service.prompt("hello"), /not running/);
	});

	it("fails start with a clear error when the executable cannot be spawned", async () => {
		const logger = memoryLogger();
		const service = new OmpService({ executable: path.join(dir, "missing"), extraArgs: [], cwd: dir, logger, autoRestart: true });
		services.push(service);
		await assert.rejects(service.start(), /ENOENT|missing/);
		assert.equal(service.connection.state, "failed");
	});
});
