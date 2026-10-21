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
import type { OmpProcessHandle } from "../../src/omp/lifecycle";
import { OmpProcess, type OmpProcessOptions } from "../../src/omp/process";
import { OmpService, type OmpServiceTuning } from "../../src/omp/service";
import { FAKE_OMP, isAlive, MemoryTransport, memoryLogger, tick, waitFor } from "./helpers";
import { MemoryOmp, NO_REPLY } from "./memoryOmp";

const codeOf = (error: unknown) => (error as { code?: unknown } | undefined)?.code;
const settle = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error);
const notices = (items: readonly TranscriptItem[]) =>
	items.flatMap(item => (item.kind === "notice" ? [`${item.level}: ${item.text}`] : []));

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

	function create(options: { autoRestart?: boolean; trace?: boolean; env?: NodeJS.ProcessEnv; tuning?: OmpServiceTuning } = {}) {
		const logger = memoryLogger({ trace: options.trace });
		const service = new OmpService(
			{
				executable: FAKE_OMP,
				extraArgs: [],
				cwd: dir,
				env: { ...process.env, FAKE_OMP_SESSION_DIR: path.join(dir, "sessions"), FAKE_OMP_LOG: logFile, ...options.env },
				logger,
				autoRestart: options.autoRestart ?? false,
			},
			{ restartDelaysMs: [20, 20, 20], restartWindowMs: 60_000, shutdownGraceMs: 1000, ...options.tuning },
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

	/** Commands fake-omp logged; a last line it is still writing has no newline yet and is left out. */
	const sentCommands = () =>
		fs.existsSync(logFile)
			? fs
					.readFileSync(logFile, "utf8")
					.split("\n")
					.slice(0, -1)
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
			["user", "assistant", "turn_summary"],
		);
		const summary = service.transcript.at(-1);
		assert.ok(summary?.kind === "turn_summary" && summary.status === "completed" && summary.usage.output > 0 && (summary.durationMs ?? -1) >= 0);
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

	it("discovers OMP's slash commands with aliases, hints, subcommands and skills", async () => {
		const { service } = create();
		await service.start();
		await waitFor(() => sentCommands().some(c => c.type === "get_available_commands"), 3000, "commands request");
		await waitFor(() => service.session.commands.some(c => c.name === "effort"), 3000, "fetched commands");
		const byName = new Map(service.session.commands.map(c => [c.name, c]));
		assert.deepEqual(byName.get("model")?.aliases, ["models"]);
		assert.equal(byName.get("effort")?.hint, "[level]");
		assert.deepEqual(byName.get("effort")?.subcommands.map(s => s.name), ["off", "low", "medium", "high", "auto"]);
		assert.equal(byName.get("skill:codebase-review")?.source, "skill");
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

	it("never traces input answers and marks no input as secret", async () => {
		const { service, interactions, logger } = create({ trace: true });
		await service.start();
		const outcome = service.prompt("input please");
		await waitFor(() => interactions.length > 0, 5000, "input request");
		const request = interactions[0];
		assert.equal(request.kind, "input");
		assert.ok(!("secret" in request));
		service.respondInteraction(request.id, { kind: "value", value: "hunter2-token" });
		await outcome;
		assert.deepEqual(assistantTexts(service), ["Received 13 characters"]);
		assert.ok(logger.text("trace").includes("extension_ui_response"));
		assert.ok(!logger.records.some(r => r.message.includes("hunter2-token")));
		assert.ok(sentCommands().some(c => c.type === "extension_ui_response" && c.value === "hunter2-token"));
	});

	it("round-trips an editor interaction", async () => {
		const { service, interactions } = create();
		await service.start();
		const outcome = service.prompt("editor please");
		await waitFor(() => interactions.length > 0, 5000, "editor request");
		assert.deepEqual(interactions[0], { id: interactions[0].id, kind: "editor", title: "Edit the plan", prefill: "step 1" });
		service.respondInteraction(interactions[0].id, { kind: "value", value: "step 2" });
		await outcome;
		assert.deepEqual(assistantTexts(service), ["Edited: step 2"]);
	});

	it("falls back to a select interaction when OMP has no ask dialog", async () => {
		const { service, interactions, logger } = create({ env: { FAKE_OMP_NO_ASK_DIALOG: "1" } });
		await service.start();
		assert.match(logger.text("info"), /ask dialog unavailable/);
		const outcome = service.prompt("ask me");
		await waitFor(() => interactions.length > 0, 5000, "select request");
		assert.deepEqual(interactions[0], {
			id: interactions[0].id,
			kind: "select",
			title: "Which database?",
			options: [{ label: "Postgres" }, { label: "SQLite", description: "Embedded" }],
			timeoutMs: 60000,
		});
		service.respondInteraction(interactions[0].id, { kind: "value", value: "SQLite" });
		await outcome;
		assert.deepEqual(assistantTexts(service), ["Selected: SQLite"]);
	});

	it("forwards presentation requests, notices, session titles and streamed tool output", async () => {
		const { service, presentations, items } = create();
		await service.start();
		await service.prompt("present things");
		assert.deepEqual(presentations, [
			{ kind: "notify", message: "Heads up", level: "warning" },
			{ kind: "status", key: "fake", text: "busy" },
			{ kind: "status", key: "fake" },
			{ kind: "openUrl", url: "https://fake.invalid/launch", instructions: "Sign in" },
			{ kind: "editorText", text: "draft text" },
		]);
		assert.deepEqual(notices(service.transcript), [
			"info: Fake notice",
			"warning: Compaction failed: too small",
			"warning: Retrying (attempt 1/3) in 2s: overloaded",
			"error: Retry failed: still overloaded",
		]);
		assert.equal(service.session.sessionName, "Presented");
		assert.equal(service.session.isCompacting, false);
		assert.ok(items.some(i => i.kind === "tool" && i.partial === "streamed line"));
		await waitFor(() => sentCommands().filter(c => c.type === "get_state").length >= 2, 3000, "state refresh after config_update");
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
			["user", "assistant", "turn_summary"],
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
			["user:remember me", "assistant:Echo: remember me", "turn_summary"],
		);
		const sessions = await second.service.listSessions();
		assert.ok(sessions.some(s => s.path === file && s.firstMessage === "remember me"));

		await second.service.newSession();
		assert.notEqual(second.service.session.sessionFile, file);
		assert.deepEqual(second.service.transcript, []);
		await second.service.switchSession(file);
		assert.equal(second.service.transcript.length, 3);
	});

	it("auto-restarts after a crash, re-binding the session, then gives up after the budget", async () => {
		const { service, states, logger } = create({ autoRestart: true });
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
		assert.match(notices(service.transcript).join("\n"), /^error: OMP process .*exited \(code 3\).*restarted/m);

		for (let i = 0; i < 2; i++) {
			const pid = service.connection.pid;
			await service.prompt("crash again");
			await waitFor(() => service.connection.state === "ready" && service.connection.pid !== pid, 5000, `restart ${i + 2}`);
		}
		await service.prompt("crash once more");
		await waitFor(() => service.connection.state === "failed", 5000, "failed");
		assert.match(service.connection.detail!, /gave up after 3 restarts/);
		assert.match(logger.text("error"), /gave up after 3 restarts/);
		assert.match(notices(service.transcript).at(-1)!, /^error: .*gave up after 3 restarts/);
		await assert.rejects(service.prompt("hello"), /not running/);
	});

	it("reports an unexpected exit without auto-restart in the transcript", async () => {
		const { service, logger } = create();
		await service.start();
		await service.prompt("please crash");
		await waitFor(() => service.connection.state === "failed", 5000, "failed");
		assert.match(service.connection.detail!, /exited \(code 3\)/);
		assert.match(notices(service.transcript).at(-1)!, /^error: OMP process .*exited \(code 3\) unexpectedly/);
		assert.match(logger.text("warn"), /exited \(code 3\).*unexpectedly/);
	});

	it("restores the restart budget once the window has passed", async () => {
		const { service } = create({ autoRestart: true, tuning: { restartDelaysMs: [20], restartWindowMs: 300 } });
		await service.start();
		for (let i = 0; i < 2; i++) {
			const pid = service.connection.pid;
			await service.prompt("please crash");
			await waitFor(() => service.connection.state === "ready" && service.connection.pid !== pid, 5000, `restart ${i + 1}`);
			await tick(400);
		}
	});

	it("does not relaunch after stop() while a restart is pending", async () => {
		const { service, states } = create({ autoRestart: true, tuning: { restartDelaysMs: [300] } });
		await service.start();
		await service.prompt("please crash");
		await waitFor(() => service.connection.state === "restarting", 5000, "restarting");
		await service.stop();
		const after = states.length;
		await tick(500);
		assert.equal(service.connection.state, "stopped");
		assert.deepEqual(states.slice(after), []);
	});

	it("reschedules when a restart attempt fails to launch", async () => {
		const marker = path.join(dir, "refuse-start");
		const { service, states } = create({
			autoRestart: true,
			env: { FAKE_OMP_EXIT_IF_EXISTS: marker },
			tuning: { restartDelaysMs: [20, 400, 20] },
		});
		await service.start();
		fs.writeFileSync(marker, "");
		await service.prompt("please crash");
		await waitFor(() => /restart failed/.test(service.connection.detail ?? ""), 5000, "failed restart rescheduled");
		assert.equal(service.connection.state, "restarting");
		fs.rmSync(marker);
		await waitFor(() => service.connection.state === "ready", 5000, "ready after retry");
		assert.deepEqual(states.filter(s => s === "restarting").length >= 2, true);
	});

	it("withdraws pending interactions when OMP exits", async () => {
		const { service, interactions, cancelled } = create();
		await service.start();
		void service.prompt("approve this");
		await waitFor(() => interactions.length > 0, 5000, "confirm request");
		process.kill(service.connection.pid!);
		await waitFor(() => service.connection.state === "failed", 5000, "failed");
		assert.deepEqual(cancelled, [interactions[0].id]);
	});

	it("starts a new session with a notice when the resumed file no longer exists", async () => {
		const first = create();
		await first.service.start({ newSession: true });
		const file = first.service.session.sessionFile!;
		await first.service.stop();
		fs.rmSync(file);
		const second = create();
		const before = sentCommands().length;
		await second.service.start({ resumeSessionFile: file });
		assert.equal(second.service.connection.state, "ready");
		assert.ok(sentCommands().slice(before).some(c => c.type === "new_session"));
		assert.notEqual(second.service.session.sessionFile, file);
		assert.match(second.logger.text("warn"), /no longer exists/);
		assert.match(notices(second.service.transcript).join("\n"), /^warning: .*no longer exists/m);
	});

	it("tells the user when an OMP extension vetoes resuming the session at start", async () => {
		const first = create();
		await first.service.start({ newSession: true });
		await first.service.prompt("remember me");
		const file = first.service.session.sessionFile!;
		await first.service.stop();
		const second = create({ env: { FAKE_OMP_CANCEL_SWITCH: "1" } });
		await second.service.start({ resumeSessionFile: file });
		assert.equal(second.service.connection.state, "ready");
		assert.notEqual(second.service.session.sessionFile, file);
		assert.match(notices(second.service.transcript).join("\n"), /^warning: Resuming .* was cancelled by an OMP extension/m);
	});

	it("loads long histories page by page", async () => {
		const first = create();
		await first.service.start({ newSession: true });
		for (const text of ["one", "two", "three"]) await first.service.prompt(text);
		const file = first.service.session.sessionFile!;
		await first.service.stop();
		const second = create({ tuning: { historyPageLimit: 2 } });
		const before = sentCommands().length;
		await second.service.start({ resumeSessionFile: file });
		const pages = sentCommands().slice(before).filter(c => c.type === "get_messages_page");
		assert.deepEqual(pages.map(p => [p.limit, p.cursor]), [[2, undefined], [2, "2"], [2, "4"]]);
		assert.deepEqual(
			second.service.transcript.map(i => i.kind),
			["user", "assistant", "turn_summary", "user", "assistant", "turn_summary", "user", "assistant", "turn_summary"],
		);
	});

	it("restart during an in-flight start ends ready and rejects the superseded start", async () => {
		const { service } = create();
		const startError = settle(service.start({ newSession: true }));
		await service.restart();
		assert.equal(service.connection.state, "ready");
		assert.ok(isAlive(service.connection.pid!));
		assert.equal(codeOf(await startError), "superseded");
	});

	it("overlapping restarts end with one ready process", async () => {
		const { service } = create();
		await service.start();
		const results = await Promise.all([settle(service.restart()), settle(service.restart())]);
		for (const error of results) assert.ok(error === undefined || codeOf(error) === "superseded", String(error));
		assert.equal(service.connection.state, "ready");
	});

	it("stop during an in-flight start rejects the start as superseded and stays stopped", async () => {
		const { service, states } = create();
		const startError = settle(service.start());
		await tick(30);
		await service.stop();
		assert.equal(codeOf(await startError), "superseded");
		assert.equal(service.connection.state, "stopped");
		assert.ok(!states.includes("failed"));
	});

	it("start while a restart is pending cancels the pending restart", async () => {
		const { service } = create({ autoRestart: true, tuning: { restartDelaysMs: [300, 300, 300] } });
		await service.start();
		await service.prompt("please crash");
		await waitFor(() => service.connection.state === "restarting", 5000, "restarting");
		await service.start();
		const pid = service.connection.pid;
		await tick(600);
		assert.equal(service.connection.state, "ready");
		assert.equal(service.connection.pid, pid);
	});

	it("recovers when the OMP process cannot be created", async () => {
		let calls = 0;
		const { service } = create({
			tuning: {
				spawn: options => {
					calls += 1;
					if (calls === 1) throw Object.assign(new Error("spawn ENAMETOOLONG"), { code: "ENAMETOOLONG" });
					return new OmpProcess(options);
				},
			},
		});
		await assert.rejects(service.start(), /ENAMETOOLONG/);
		assert.equal(service.connection.state, "failed");
		await service.start();
		assert.equal(service.connection.state, "ready");
	});

	it("rejects a main-agent steer when OMP is not running", async () => {
		const { service } = create();
		await assert.rejects(service.steerAgent("main", "go left"), /not running/);
	});

	it("fails start with a clear error when the executable cannot be spawned", async () => {
		const logger = memoryLogger();
		const service = new OmpService({ executable: path.join(dir, "missing"), extraArgs: [], cwd: dir, logger, autoRestart: true });
		services.push(service);
		await assert.rejects(service.start(), /ENOENT|missing/);
		assert.equal(service.connection.state, "failed");
	});
});

describe("OmpService against an in-memory OMP", () => {
	let services: OmpService[] = [];

	afterEach(async () => {
		for (const service of services) await service.stop().catch(() => undefined);
		services = [];
	});

	function create(omp: MemoryOmp | (() => MemoryOmp), options: { autoRestart?: boolean } = {}) {
		const logger = memoryLogger();
		const service = new OmpService(
			{ executable: "memory-omp", extraArgs: [], cwd: os.tmpdir(), logger, autoRestart: options.autoRestart ?? false },
			{ spawn: typeof omp === "function" ? omp : () => omp, shutdownGraceMs: 50 },
		);
		services.push(service);
		const interactions: InteractionRequest[] = [];
		service.onInteractionRequest(request => interactions.push(request));
		return { service, logger, interactions };
	}

	const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });

	it("keeps an interaction pending when its answer cannot be written", async () => {
		const omp = new MemoryOmp();
		const { service, interactions } = create(omp);
		await service.start();
		omp.emit({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Go?", message: "Really?" });
		await waitFor(() => interactions.length > 0, 1000, "confirm request");
		omp.failWrites = true;
		assert.throws(() => service.respondInteraction("ui-1", { kind: "confirmed", confirmed: true }), /EPIPE/);
		omp.failWrites = false;
		service.respondInteraction("ui-1", { kind: "confirmed", confirmed: true });
		assert.deepEqual(omp.sent("extension_ui_response"), [{ type: "extension_ui_response", id: "ui-1", confirmed: true }]);
	});

	it("cancels a UI request it cannot map and tells the user", async () => {
		const omp = new MemoryOmp();
		const { service, interactions, logger } = create(omp);
		await service.start();
		omp.emit({ type: "extension_ui_request", id: "ui-2", method: "select", title: "Pick one" });
		await waitFor(() => omp.sent("extension_ui_response").length > 0, 1000, "cancel reply");
		assert.deepEqual(omp.sent("extension_ui_response"), [{ type: "extension_ui_response", id: "ui-2", cancelled: true }]);
		assert.deepEqual(interactions, []);
		assert.match(logger.text("warn"), /select/);
		assert.match(notices(service.transcript).join("\n"), /^warning: .*select/m);
	});

	it("ignores frames from a process that has already exited", async () => {
		const omp = new MemoryOmp();
		const { service } = create(omp);
		await service.start();
		omp.close(3);
		await waitFor(() => service.connection.state === "failed", 1000, "failed");
		const before = service.transcript.length;
		omp.emit({ type: "message_start", messageId: "late", message: user("late frame") });
		omp.emit({ type: "extension_ui_request", id: "ui-late", method: "confirm", title: "Late?", message: "late" });
		await tick(20);
		assert.equal(service.transcript.length, before);
	});

	it("ends failed when the process cannot be shut down", async () => {
		const omp = new MemoryOmp();
		const { service } = create(omp);
		await service.start();
		omp.shutdownError = new Error("OMP process did not exit after SIGKILL");
		await assert.rejects(service.stop(), /SIGKILL/);
		assert.equal(service.connection.state, "failed");
		assert.match(service.connection.detail!, /SIGKILL/);
		omp.shutdownError = undefined;
	});

	it("start queued behind a failing automatic restart cancels the restart that failure schedules", async () => {
		const spawned: MemoryOmp[] = [];
		const service = new OmpService(
			{ executable: "memory-omp", extraArgs: [], cwd: os.tmpdir(), logger: memoryLogger(), autoRestart: true },
			{
				spawn: () => {
					const omp = spawned.length === 1 ? new MemoryOmp({ negotiate_protocol: () => NO_REPLY }) : new MemoryOmp();
					spawned.push(omp);
					return omp;
				},
				shutdownGraceMs: 50,
				restartDelaysMs: [10, 10, 10],
			},
		);
		services.push(service);
		await service.start();
		spawned[0].close(1);
		await waitFor(() => spawned.length === 2, 1000, "automatic restart attempt");
		const started = service.start();
		spawned[1].close(1);
		await started;
		// Nothing signals a restart that does not happen; this outlasts the 10 ms delay of one that would.
		await tick(100);
		assert.equal(spawned.length, 3);
		assert.equal(service.connection.pid, spawned[2].pid);
		assert.equal(spawned[2].closed, false);
	});

	it("falls back to get_messages when message pages change while loading", async () => {
		const history = [user("a"), user("b"), user("c"), user("d")];
		let page = 0;
		const omp = new MemoryOmp({
			get_messages_page: () => {
				page += 1;
				return page === 1
					? { messages: history.slice(0, 1), totalMessages: 3, nextCursor: "1" }
					: { messages: history.slice(1, 2), totalMessages: 4, nextCursor: "2" };
			},
			get_messages: () => ({ messages: history }),
		});
		const { service, logger } = create(omp);
		await service.start();
		assert.deepEqual(
			service.transcript.map(item => (item.kind === "user" ? item.text : item.kind)),
			["a", "b", "c", "d"],
		);
		assert.equal(omp.sent("get_messages_page").length, 2);
		assert.match(logger.text("debug"), /changed while loading/);
	});

	it("shows the switched-to session with an empty transcript when its history fails to load", async () => {
		let switched = false;
		const fail = (frame: Record<string, unknown>, omp: MemoryOmp) => {
			if (!switched) return frame.type === "get_messages_page" ? { messages: [user("old")], totalMessages: 1 } : { messages: [user("old")] };
			omp.emit({ type: "response", id: frame.id, command: frame.type, success: false, error: "history unavailable" });
			return NO_REPLY;
		};
		const omp = new MemoryOmp({
			get_state: () => ({
				sessionId: switched ? "new" : "old",
				sessionFile: switched ? "/sessions/new.jsonl" : "/sessions/old.jsonl",
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				messageCount: switched ? 2 : 1,
			}),
			switch_session: () => {
				switched = true;
				return { cancelled: false };
			},
			get_messages_page: fail,
			get_messages: fail,
		});
		const { service } = create(omp);
		await service.start();
		assert.equal(service.transcript.length, 1);
		await assert.rejects(service.switchSession("/sessions/new.jsonl"), /history unavailable/);
		assert.equal(service.session.sessionFile, "/sessions/new.jsonl");
		assert.deepEqual(service.transcript, []);
	});

	it("hands the cause of a failed optional setup step to the logger", async () => {
		const omp = new MemoryOmp({
			set_event_filter: (frame, transport) => {
				transport.emit({ type: "response", id: frame.id, command: "set_event_filter", success: false, error: "no filter", code: "unsupported" });
				return NO_REPLY;
			},
		});
		const { service, logger } = create(omp);
		const causes: unknown[] = [];
		const warn = logger.warn;
		logger.warn = (message, error) => {
			causes.push(error);
			warn(message, error);
		};
		await service.start();
		assert.equal(codeOf(causes[0]), "unsupported");
	});

	const commandNames = (service: OmpService) => service.session.commands.map(c => c.name);
	const commandsFrame = (...names: string[]) => ({
		type: "available_commands_update",
		commands: names.map(name => ({ name, source: name.startsWith("skill:") ? "skill" : "builtin" })),
	});

	it("stores the slash commands of every available_commands_update frame", async () => {
		const omp = new MemoryOmp();
		const { service } = create(omp);
		const seen: string[][] = [];
		service.onDidChangeSession(session => seen.push(session.commands.map(c => c.name)));
		await service.start();
		await waitFor(() => omp.sent("get_available_commands").length > 0, 1000, "initial fetch");
		await tick(5);
		omp.emit({
			type: "available_commands_update",
			commands: [{ name: "effort", input: { hint: "[level]" }, subcommands: [{ name: "auto" }], source: "builtin" }, { name: "" }],
		});
		assert.deepEqual(service.session.commands, [
			{ name: "effort", source: "builtin", aliases: [], hint: "[level]", subcommands: [{ name: "auto" }] },
		]);
		assert.deepEqual(seen.at(-1), ["effort"]);
		omp.emit(commandsFrame("model", "skill:review"));
		assert.deepEqual(commandNames(service), ["model", "skill:review"]);
	});

	it("keeps the slash commands and warns when a frame carries no command list", async () => {
		const omp = new MemoryOmp();
		const { service, logger } = create(omp);
		await service.start();
		await waitFor(() => omp.sent("get_available_commands").length > 0, 1000, "initial fetch");
		await tick(5);
		omp.emit(commandsFrame("model"));
		omp.emit({ type: "available_commands_update", commands: { name: "broken" } });
		assert.deepEqual(commandNames(service), ["model"]);
		assert.match(logger.text("warn"), /slash commands/i);
	});

	it("requests the slash commands once the launch is ready", async () => {
		const omp = new MemoryOmp({
			get_available_commands: () => ({ commands: [{ name: "model", aliases: ["models"], source: "builtin" }, { name: "skill:review", source: "skill" }] }),
		});
		const { service } = create(omp);
		await service.start();
		await waitFor(() => service.session.commands.length > 0, 1000, "fetched commands");
		assert.deepEqual(service.session.commands, [
			{ name: "model", source: "builtin", aliases: ["models"], subcommands: [] },
			{ name: "skill:review", source: "skill", aliases: [], subcommands: [] },
		]);
		assert.equal(omp.sent("get_available_commands").length, 1);
	});

	it("warns and keeps frame-delivered slash commands when OMP rejects the request", async () => {
		const omp = new MemoryOmp({
			get_available_commands: (frame, transport) => {
				transport.emit(commandsFrame("model"));
				transport.emit({ type: "response", id: frame.id, command: "get_available_commands", success: false, error: "Unknown command: get_available_commands" });
				return NO_REPLY;
			},
		});
		const { service, logger } = create(omp);
		await service.start();
		await waitFor(() => /get_available_commands/.test(logger.text("warn")), 1000, "rejection warning");
		assert.deepEqual(commandNames(service), ["model"]);
		assert.equal(service.connection.state, "ready");
	});

	it("keeps the slash commands across a restart until the new process reports its own", async () => {
		const omps: MemoryOmp[] = [];
		const { service } = create(() => {
			const first = omps.length === 0;
			const omp = new MemoryOmp({
				get_available_commands: () => (first ? { commands: [{ name: "old", source: "builtin" }] } : NO_REPLY),
			});
			omps.push(omp);
			return omp;
		});
		await service.start();
		await waitFor(() => service.session.commands.length > 0, 1000, "first commands");
		await service.restart();
		assert.equal(omps.length, 2);
		await waitFor(() => omps[1]!.sent("get_available_commands").length > 0, 1000, "second fetch");
		assert.deepEqual(commandNames(service), ["old"]);
		omps[0]!.emit(commandsFrame("stale"));
		assert.deepEqual(commandNames(service), ["old"]);
		omps[1]!.emit(commandsFrame("new", "skill:x"));
		assert.deepEqual(commandNames(service), ["new", "skill:x"]);
	});

	describe("pending prompt items", () => {
		const userItems = (service: OmpService) => service.transcript.flatMap(item => (item.kind === "user" ? [{ ...item }] : []));

		it("keeps the item of a local command, no longer pending, before its output", async () => {
			const omp = new MemoryOmp({
				prompt: (frame, transport) => {
					transport.reply(frame, { agentInvoked: false });
					transport.emit({ type: "command_output", text: "No rules." });
					return NO_REPLY;
				},
			});
			const { service } = create(omp);
			await service.start();
			const id = service.addPendingPrompt("/rules", 0);
			assert.ok(id);
			assert.deepEqual(userItems(service), [{ kind: "user", id, text: "/rules", pending: true }]);
			const outcome = await service.prompt("/rules", "auto", [], id);
			assert.equal(outcome.status, "local");
			assert.deepEqual(userItems(service), [{ kind: "user", id, text: "/rules" }]);
			assert.deepEqual(service.transcript.map(item => item.kind), ["user", "command_output"]);
		});

		it("removes the item when OMP rejects the prompt", async () => {
			const omp = new MemoryOmp({
				prompt: (frame, transport) => {
					transport.emit({ type: "response", id: frame.id, command: "prompt", success: false, error: "busy" });
					return NO_REPLY;
				},
			});
			const { service } = create(omp);
			await service.start();
			const id = service.addPendingPrompt("hello", 0);
			const outcome = await service.prompt("hello", "auto", [], id);
			assert.equal(outcome.status, "error");
			assert.deepEqual(userItems(service), []);
		});

		it("removes the item when OMP is not running", async () => {
			const { service } = create(new MemoryOmp());
			const id = service.addPendingPrompt("hello", 0);
			await assert.rejects(service.prompt("hello", "auto", [], id), /not running/);
			assert.deepEqual(userItems(service), []);
		});

		it("adds no item while a prompt is in progress", async () => {
			const omp = new MemoryOmp({ prompt: () => NO_REPLY });
			const { service } = create(omp);
			await service.start();
			void service.prompt("first");
			assert.equal(service.addPendingPrompt("second", 0), undefined);
			assert.deepEqual(userItems(service), []);
		});
	});

	describe("turn summaries", () => {
		const reply = (stopReason: string) => ({
			role: "assistant",
			content: [],
			api: "a",
			provider: "p",
			model: "m",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
			stopReason,
			timestamp: 1,
		});
		const statuses = (service: OmpService) => service.transcript.flatMap(item => (item.kind === "turn_summary" ? [item.status] : []));

		for (const status of ["error", "aborted"] as const) {
			it(`ends a turn whose prompt result is ${status} with a summary saying so`, async () => {
				const omp = new MemoryOmp({
					prompt: (frame, transport) => {
						transport.reply(frame, { agentInvoked: true });
						transport.emit({ type: "agent_start" });
						transport.emit({ type: "message_end", messageId: "a-1", message: reply("stop") });
						transport.emit({ type: "agent_end", messages: [] });
						transport.emit({ type: "prompt_result", id: frame.id, agentInvoked: true, status, sessionSettled: true, ...(status === "error" ? { error: { message: "quota", retryable: false } } : {}) });
						return NO_REPLY;
					},
				});
				const { service } = create(omp);
				await service.start();
				await service.prompt("go");
				assert.deepEqual(statuses(service), [status]);
			});
		}

		it("ends the turn as failed when OMP exits in the middle of it", async () => {
			const omp = new MemoryOmp({
				prompt: (frame, transport) => {
					transport.reply(frame, { agentInvoked: true });
					transport.emit({ type: "agent_start" });
					transport.emit({ type: "message_end", messageId: "a-1", message: reply("toolUse") });
					return NO_REPLY;
				},
			});
			const { service } = create(omp);
			await service.start();
			const outcome = service.prompt("go");
			await waitFor(() => service.session.turn?.outputTokens === 2, 1000, "reply counted");
			omp.close(1);
			await outcome;
			assert.deepEqual(statuses(service), ["error"]);
		});
	});

	describe("statuses, usage and abort", () => {
		const usageText = (...lines: string[]) => ["```", "Usage (0s ago)", "", "Google Antigravity", ...lines, "```"].join("\n");
		const REPORT = usageText("- Gemini — Weekly", "  me@example.com: 9.64% used (90.4% left)", "  resets in 7d");
		const BUCKETS = JSON.stringify({
			reports: [
				{
					provider: "google-antigravity",
					limits: [{ id: "g:gemini-argon-wtu-weekly", label: "Gemini", window: { label: "Weekly" }, amount: { usedFraction: 0.0964 } }],
				},
			],
		});

		interface UsageRun {
			options: OmpProcessOptions;
			shutdown: number;
		}

		/** `omp usage --json` as a process that prints `stdout` and exits with `code`. */
		function usageProcess(runs: UsageRun[], options: OmpProcessOptions, stdout: string, code: number): OmpProcessHandle {
			const run: UsageRun = { options, shutdown: 0 };
			runs.push(run);
			const transport = new MemoryTransport();
			setImmediate(() => {
				transport.emit(stdout);
				transport.close(code, null, code === 0 ? {} : { stderr: "no credentials" });
			});
			return Object.assign(transport, {
				pid: 1,
				shutdown: () => {
					run.shutdown++;
					return Promise.resolve();
				},
			});
		}

		function start(omp: MemoryOmp, usage: { stdout: string; code: number } = { stdout: BUCKETS, code: 0 }, requestTimeoutMs?: number) {
			const logger = memoryLogger();
			const runs: UsageRun[] = [];
			const service = new OmpService(
				{ executable: "memory-omp", extraArgs: [], cwd: os.tmpdir(), logger, autoRestart: false, requestTimeoutMs },
				{ spawn: options => (options.mode ? usageProcess(runs, options, usage.stdout, usage.code) : omp), shutdownGraceMs: 50 },
			);
			services.push(service);
			const presentations: PresentationRequest[] = [];
			service.onPresentation(request => presentations.push(request));
			return { service, logger, runs, presentations };
		}

		/** Answers `/usage` with `output` as command output before the prompt's response. */
		const usageOmp = (...output: string[]) =>
			new MemoryOmp({
				prompt: (frame, transport) => {
					for (const text of output) transport.emit({ type: "command_output", text });
					transport.reply(frame, { agentInvoked: false });
					return NO_REPLY;
				},
			});

		const setStatus = (id: string, statusKey: string, statusText?: string) => ({
			type: "extension_ui_request",
			id,
			method: "setStatus",
			statusKey,
			...(statusText === undefined ? {} : { statusText }),
		});

		it("keeps the current status texts in OMP order and withdraws each one when the process ends", async () => {
			const omp = new MemoryOmp();
			const { service, presentations } = start(omp);
			await service.start();
			omp.emit(setStatus("s1", "tier", "tier-router: on (main on)"));
			omp.emit(setStatus("s2", "lsp", "ready"));
			omp.emit(setStatus("s3", "tmp", "x"));
			omp.emit(setStatus("s4", "lsp", "busy"));
			omp.emit(setStatus("s5", "tmp", ""));
			await waitFor(() => presentations.length === 5, 1000, "statuses");
			assert.deepEqual([...service.statuses], [
				["tier", "tier-router: on (main on)"],
				["lsp", "busy"],
			]);
			presentations.length = 0;
			omp.close(1);
			await waitFor(() => service.connection.state === "failed", 1000, "process end");
			assert.deepEqual(presentations, [
				{ kind: "status", key: "tier" },
				{ kind: "status", key: "lsp" },
			]);
			assert.deepEqual([...service.statuses], []);
		});

		it("reads usage from /usage output kept off the transcript and names buckets from omp usage --json", async () => {
			const omp = usageOmp(REPORT);
			const { service, runs } = start(omp);
			await service.start();
			const usage = await service.getUsage();
			assert.deepEqual(usage, [
				{ provider: "Google Antigravity", limits: [{ name: "Gemini Argon — Weekly", account: "me@example.com", usedPercent: 9.6, inUse: false, resets: "in 7d" }] },
			]);
			assert.deepEqual(omp.sent("prompt").map(frame => ({ ...frame, id: undefined })), [{ type: "prompt", message: "/usage", id: undefined }]);
			assert.deepEqual(service.transcript, []);
			assert.equal(service.session.phase, "idle");
			assert.deepEqual(
				runs.map(run => [run.options.executable, run.options.mode, run.options.cwd, run.shutdown]),
				[["memory-omp", ["usage", "--json"], os.tmpdir(), 1]],
			);
			omp.emit({ type: "command_output", text: "later" });
			await waitFor(() => service.transcript.length === 1, 1000, "later output");
		});

		it("keeps the /usage names and warns when omp usage --json fails", async () => {
			const { service, logger } = start(usageOmp(REPORT), { stdout: "", code: 1 });
			await service.start();
			const [provider] = await service.getUsage();
			assert.deepEqual(provider.limits.map(limit => limit.name), ["Gemini — Weekly"]);
			assert.match(logger.text("warn"), /omp usage --json failed \(exit 1\): no credentials; limits keep the names \/usage gives/);
		});

		it("fails when OMP printed no usage report", async () => {
			const { service } = start(usageOmp("Unknown command: /usage"));
			await service.start();
			await assert.rejects(service.getUsage(), /^Error: OMP printed no usage report$/);
			assert.deepEqual(service.transcript, []);
		});

		it("runs one usage request at a time", async () => {
			const prompts: Array<Record<string, unknown>> = [];
			const omp = new MemoryOmp({
				prompt: frame => {
					prompts.push(frame);
					return NO_REPLY;
				},
			});
			const answer = (frame: Record<string, unknown>) => {
				omp.emit({ type: "command_output", text: REPORT });
				omp.reply(frame, { agentInvoked: false });
			};
			const { service } = start(omp);
			await service.start();
			const first = service.getUsage();
			const second = service.getUsage();
			await waitFor(() => prompts.length === 1, 1000, "first /usage");
			await tick(20);
			assert.equal(prompts.length, 1);
			answer(prompts[0]);
			await first;
			await waitFor(() => prompts.length === 2, 1000, "second /usage");
			answer(prompts[1]);
			assert.equal((await second).length, 1);
		});

		const outputs = (service: OmpService) => service.transcript.flatMap(item => (item.kind === "command_output" ? [item.text] : []));

		it("sends a prompt given while /usage runs once /usage is answered, so its command output reaches the transcript", async () => {
			const usagePrompts: Array<Record<string, unknown>> = [];
			const omp = new MemoryOmp({
				prompt: (frame, transport) => {
					if (frame.message === "/usage") {
						usagePrompts.push(frame);
						return NO_REPLY;
					}
					transport.emit({ type: "command_output", text: "No rules" });
					return { agentInvoked: false };
				},
			});
			const { service } = start(omp);
			await service.start();
			const usage = service.getUsage();
			await waitFor(() => usagePrompts.length === 1, 1000, "/usage");
			const rules = service.prompt("/rules");
			omp.emit({ type: "command_output", text: REPORT });
			omp.reply(usagePrompts[0], { agentInvoked: false });
			assert.equal((await usage).length, 1);
			assert.equal((await rules).status, "local");
			assert.deepEqual(omp.sent("prompt").map(frame => frame.message), ["/usage", "/rules"]);
			assert.deepEqual(outputs(service), ["No rules"]);
		});

		it("sends /usage once the prompts sent before it are answered, so their command output reaches the transcript", async () => {
			const prompts: Array<Record<string, unknown>> = [];
			const omp = new MemoryOmp({
				prompt: frame => {
					prompts.push(frame);
					return NO_REPLY;
				},
			});
			const { service } = start(omp);
			await service.start();
			const rules = service.prompt("/rules");
			await waitFor(() => prompts.length === 1, 1000, "/rules");
			const usage = service.getUsage();
			// Lets the usage request begin as far as it can before OMP answers /rules.
			await tick();
			omp.emit({ type: "command_output", text: "No rules" });
			omp.reply(prompts[0], { agentInvoked: false });
			await waitFor(() => prompts.length === 2, 1000, "/usage");
			omp.emit({ type: "command_output", text: REPORT });
			omp.reply(prompts[1], { agentInvoked: false });
			assert.equal((await usage).length, 1);
			assert.equal((await rules).status, "local");
			assert.deepEqual(prompts.map(frame => frame.message), ["/rules", "/usage"]);
			assert.deepEqual(outputs(service), ["No rules"]);
		});

		it("keeps capturing /usage output until OMP answers, however long that takes", async () => {
			const prompts: Array<Record<string, unknown>> = [];
			const omp = new MemoryOmp({
				prompt: frame => {
					prompts.push(frame);
					return NO_REPLY;
				},
			});
			const { service } = start(omp, undefined, 50);
			await service.start();
			const usage = service.getUsage();
			await waitFor(() => prompts.length === 1, 1000, "/usage");
			// Outlasts the 50 ms request timeout, which only a real wait can.
			await tick(100);
			omp.emit({ type: "command_output", text: REPORT });
			omp.reply(prompts[0], { agentInvoked: false });
			assert.equal((await usage).length, 1);
			assert.deepEqual(service.transcript, []);
		});

		it("cancels every running or pending subagent on abort and logs the cancellations that fail", async () => {
			const snapshot = (id: string, status: string) => ({ id, index: 0, agent: "task", agentSource: "bundled", status, lastUpdate: 1 });
			const omp = new MemoryOmp({
				get_subagents: () => ({ subagents: [snapshot("A", "running"), snapshot("B", "pending"), snapshot("C", "completed")] }),
				cancel_subagent: (frame, transport) => {
					if (frame.subagentId === "A") return { cancelled: true };
					transport.emit({ type: "response", id: frame.id, command: "cancel_subagent", success: false, error: "gone" });
					return NO_REPLY;
				},
			});
			const { service, logger } = start(omp);
			await service.start();
			await service.abort();
			assert.deepEqual(omp.written.flatMap(frame => (frame.type === "abort" ? ["abort"] : frame.type === "cancel_subagent" ? [frame.subagentId] : [])), ["abort", "A", "B"]);
			assert.match(logger.text("warn"), /Cancelling subagent B after abort failed: .*gone/);
		});
	});
});
