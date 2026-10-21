import * as assert from "node:assert/strict";
import type { ConnectionStatus, OmpServiceApi, SessionBinding, SessionView } from "../../src/omp/api";
import { type Deferred, deferred } from "../../src/shared/deferred";
import { emptySessionView } from "../../src/shared/session";
import { type ServiceConsumer, ServiceSupervisor } from "../../src/ui/ServiceSupervisor";
import { type MemoryLogger, memoryLogger, tick } from "./helpers";
import { EventEmitter, stub, workspace } from "./stubs/vscode";

function superseded(): Error {
	return Object.assign(new Error("OMP start was superseded by a restart"), { code: "superseded" });
}

class FakeService {
	connection: ConnectionStatus = { state: "stopped" };
	session: SessionView = emptySessionView();
	readonly sessionChanges = new EventEmitter<SessionView>();
	readonly connectionChanges = new EventEmitter<ConnectionStatus>();
	readonly onDidChangeSession = this.sessionChanges.event;
	readonly onDidChangeConnection = this.connectionChanges.event;
	readonly starts: Array<{ options: SessionBinding | undefined; done: Deferred<void> }> = [];
	readonly restarts: Array<Deferred<void>> = [];
	stops = 0;
	disposed = false;
	/** While set, `stop()` waits for it. */
	stopGate: Deferred<void> | undefined;

	start(options?: SessionBinding): Promise<void> {
		const done = deferred<void>();
		this.starts.push({ options, done });
		this.setConnection({ state: "starting" });
		return done.promise;
	}

	restart(): Promise<void> {
		const done = deferred<void>();
		this.restarts.push(done);
		return done.promise;
	}

	async stop(): Promise<void> {
		this.stops++;
		this.setConnection({ state: "stopped" });
		await this.stopGate?.promise;
	}

	dispose(): void {
		this.disposed = true;
	}

	setConnection(status: ConnectionStatus): void {
		this.connection = status;
		this.connectionChanges.fire(status);
	}

	setSession(change: Partial<SessionView>): void {
		this.session = { ...this.session, ...change };
		this.sessionChanges.fire(this.session);
	}

	get api(): OmpServiceApi {
		return this as unknown as OmpServiceApi;
	}
}

describe("ServiceSupervisor", () => {
	let logger: MemoryLogger;
	let services: FakeService[];
	let createError: Error | undefined;
	let unavailable: string[];
	let consumed: Array<OmpServiceApi | undefined>;
	let shownLog: number;
	let lastSession: string | undefined;
	let supervisor: ServiceSupervisor;

	const contexts = (key: string) =>
		stub
			.callsTo("commands.executeCommand")
			.filter(([command, name]) => command === "setContext" && name === key)
			.map(([, , value]) => value);
	const errors = () => stub.callsTo("window.showErrorMessage").map(([message]) => String(message));

	beforeEach(() => {
		stub.reset();
		workspace.workspaceFolders = [{ uri: { fsPath: "/work" }, name: "work", index: 0 }];
		logger = memoryLogger();
		services = [];
		createError = undefined;
		unavailable = [];
		consumed = [];
		shownLog = 0;
		lastSession = undefined;
		const consumer: ServiceConsumer = { setService: service => consumed.push(service) };
		supervisor = new ServiceSupervisor({
			create: () => {
				if (createError) throw createError;
				const service = new FakeService();
				services.push(service);
				return service.api;
			},
			consumers: [consumer],
			showUnavailable: message => unavailable.push(message),
			resumeOptions: preferred => {
				const file = preferred ?? lastSession;
				return file ? { resumeSessionFile: file } : undefined;
			},
			onSession: () => {},
			logger,
			output: { show: () => shownLog++ },
		});
	});

	afterEach(() => supervisor.dispose());

	async function ready(): Promise<FakeService> {
		supervisor.initialize();
		const service = services[0];
		service.setConnection({ state: "ready" });
		service.starts[0].done.resolve();
		await tick();
		return service;
	}

	it("creates the service, hands it to every consumer and starts it", async () => {
		const service = await ready();
		assert.deepEqual(consumed, [service.api]);
		assert.equal(service.starts.length, 1);
		assert.equal(supervisor.service, service.api);
	});

	it("does not start OMP on activation in manual startup mode", () => {
		stub.config.set("omp.startup", "manual");
		supervisor.initialize();
		assert.equal(services[0].starts.length, 0);
		assert.equal(supervisor.needsStart(), true);
	});

	it("resumes the last session on activation by default", () => {
		lastSession = "/sessions/last.jsonl";
		supervisor.initialize();
		assert.deepEqual(services[0].starts[0].options, { resumeSessionFile: "/sessions/last.jsonl" });
	});

	it("starts a new session on activation in newSession startup mode", () => {
		stub.config.set("omp.startup", "newSession");
		lastSession = "/sessions/last.jsonl";
		supervisor.initialize();
		assert.deepEqual(services[0].starts[0].options, { newSession: true });
	});

	it("does not start OMP on activation without a workspace folder", () => {
		workspace.workspaceFolders = undefined;
		supervisor.initialize();
		assert.equal(services[0].starts.length, 0);
		assert.equal(supervisor.needsStart(), true);
		assert.match(logger.text("info"), /No workspace folder is open/);
	});

	it("without a workspace folder builds the service again when OMP first starts, so its folder follows the editor active then", async () => {
		workspace.workspaceFolders = undefined;
		supervisor.initialize();
		const idle = services[0];
		const ensured = supervisor.ensureService();
		assert.equal(services.length, 2, "built again at first use");
		assert.equal(idle.disposed, true);
		assert.equal(idle.starts.length, 0);
		const started = services[1];
		assert.equal(started.starts.length, 1);
		assert.equal(supervisor.service, started.api);
		assert.deepEqual(consumed, [idle.api, undefined, started.api]);
		started.setConnection({ state: "ready" });
		started.starts[0].done.resolve();
		assert.equal(await ensured, started.api);
		await supervisor.ensureService();
		assert.equal(services.length, 2, "built only once");
	});

	it("without a workspace folder builds the service again when OMP: Restart first starts it", async () => {
		workspace.workspaceFolders = undefined;
		supervisor.initialize();
		const restarted = supervisor.restart();
		assert.equal(services.length, 2);
		assert.equal(services[0].disposed, true);
		assert.equal(services[1].starts.length, 1);
		services[1].setConnection({ state: "ready" });
		services[1].starts[0].done.resolve();
		await restarted;
	});

	it("hands no service to the consumers when the service cannot be built again at first use", async () => {
		workspace.workspaceFolders = undefined;
		supervisor.initialize();
		createError = new Error("omp.extraArgs must be an array of strings");
		await assert.rejects(supervisor.ensureService(), /omp\.extraArgs must be an array of strings/);
		assert.equal(services[0].disposed, true);
		assert.deepEqual(consumed, [services[0].api, undefined]);
		assert.deepEqual(unavailable, ["omp.extraArgs must be an array of strings"]);
	});

	it("resumes the current session when a command starts OMP after it failed", async () => {
		const service = await ready();
		service.setSession({ sessionFile: "/sessions/current.jsonl" });
		service.setConnection({ state: "failed", detail: "OMP exited with code 1; gave up after 3 restarts" });
		const ensured = supervisor.ensureService();
		assert.deepEqual(service.starts[1]?.options, { resumeSessionFile: "/sessions/current.jsonl" });
		service.setConnection({ state: "ready" });
		service.starts[1].done.resolve();
		assert.equal(await ensured, service.api);
	});

	it("waits for an automatic restart before handing out the service", async () => {
		const service = await ready();
		service.setConnection({ state: "restarting", detail: "OMP exited with code 1; restart 1/3 in 10 ms" });
		let ensured: OmpServiceApi | undefined;
		const ensuring = supervisor.ensureService().then(result => (ensured = result));
		await tick();
		assert.equal(ensured, undefined, "still restarting");
		service.setConnection({ state: "ready" });
		await ensuring;
		assert.equal(ensured, service.api);
		assert.equal(service.starts.length, 1, "the automatic restart is not doubled by a start");
	});

	it("reports a failed start once, with Show Log", async () => {
		stub.on("window.showErrorMessage", () => "Show Log");
		supervisor.initialize();
		const service = services[0];
		service.setConnection({ state: "failed", detail: "spawn ENOENT" });
		service.starts[0].done.reject(new Error("spawn ENOENT"));
		await tick();
		await tick();
		assert.deepEqual(errors(), ["OMP failed to start: spawn ENOENT"]);
		assert.equal(shownLog, 1);
	});

	it("reports OMP stopping on its own and offers a restart", async () => {
		const service = await ready();
		stub.on("window.showErrorMessage", () => "Restart");
		service.setConnection({ state: "failed", detail: "OMP exited with code 1; gave up after 3 restarts" });
		await tick();
		await tick();
		const [message, ...actions] = stub.callsTo("window.showErrorMessage")[0] ?? [];
		assert.equal(message, "OMP stopped: OMP exited with code 1; gave up after 3 restarts");
		assert.deepEqual(actions, ["Restart", "Show Log"]);
		assert.equal(service.starts.length, 2, "Restart starts OMP again");
	});

	it("does not report a start that a restart superseded", async () => {
		supervisor.initialize();
		const service = services[0];
		const restarted = supervisor.restart();
		service.starts[0].done.reject(superseded());
		service.restarts[0].resolve();
		await restarted;
		await tick();
		assert.deepEqual(errors(), []);
		assert.equal(service.restarts.length, 1);
	});

	it("waits for the restart when the start it was waiting for is superseded", async () => {
		supervisor.initialize();
		const service = services[0];
		const ensured = supervisor.ensureService();
		const restarted = supervisor.restart();
		service.starts[0].done.reject(superseded());
		await tick();
		let settled = false;
		void ensured.then(
			() => (settled = true),
			() => (settled = true),
		);
		await tick();
		assert.equal(settled, false, "still waiting for the restart");
		service.restarts[0].resolve();
		assert.equal(await ensured, service.api);
		await restarted;
	});

	it("runs one restart at a time", async () => {
		const service = await ready();
		const first = supervisor.restart();
		const second = supervisor.restart();
		await tick();
		assert.equal(service.restarts.length, 1);
		service.restarts[0].resolve();
		await Promise.all([first, second]);
	});

	it("does not report a restart failure as OMP stopping on its own", async () => {
		const service = await ready();
		const restarted = supervisor.restart();
		service.setConnection({ state: "failed", detail: "spawn ENOENT" });
		service.restarts[0].reject(new Error("spawn ENOENT"));
		await assert.rejects(restarted, /spawn ENOENT/);
		await tick();
		assert.deepEqual(errors(), []);
	});

	it("clears the busy and thinking-level contexts when the service stops", async () => {
		const service = await ready();
		service.setSession({ phase: "running", availableThinkingLevels: ["low", "high"] });
		assert.equal(contexts("omp.busy").at(-1), true);
		assert.equal(contexts("omp.hasThinkingLevels").at(-1), true);
		await supervisor.stop();
		assert.equal(contexts("omp.busy").at(-1), false);
		assert.equal(contexts("omp.hasThinkingLevels").at(-1), false);
		assert.equal(service.disposed, true);
		assert.deepEqual(consumed, [service.api, undefined]);
	});

	it("keeps the contexts cleared when the recreated service cannot be built", async () => {
		const service = await ready();
		service.setSession({ phase: "running", availableThinkingLevels: ["low"] });
		createError = new Error("OMP executable not found");
		await supervisor.recreate();
		assert.deepEqual(unavailable, ["OMP executable not found"]);
		assert.equal(contexts("omp.busy").at(-1), false);
		assert.equal(contexts("omp.hasThinkingLevels").at(-1), false);
		assert.match(errors()[0], /OMP executable not found/);
	});

	it("recreates the service and resumes its session", async () => {
		const service = await ready();
		service.setSession({ sessionFile: "/sessions/a.jsonl" });
		await supervisor.recreate();
		assert.equal(service.stops, 1);
		assert.equal(services.length, 2);
		assert.deepEqual(services[1].starts[0].options, { resumeSessionFile: "/sessions/a.jsonl" });
	});

	it("waits for a recreation in progress instead of reporting OMP missing", async () => {
		const service = await ready();
		service.stopGate = deferred();
		const recreated = supervisor.recreate();
		const ensured = supervisor.ensureService();
		service.stopGate.resolve();
		await recreated;
		const replacement = services[1];
		replacement.setConnection({ state: "ready" });
		replacement.starts[0].done.resolve();
		assert.equal(await ensured, replacement.api);
	});

	it("starts no new service once disposed while a recreation stops the old one", async () => {
		const service = await ready();
		service.stopGate = deferred();
		const recreated = supervisor.recreate();
		await tick();
		supervisor.dispose();
		service.stopGate.resolve();
		await recreated;
		assert.equal(services.length, 1);
	});

	it("starts no new service after shutdown while a recreation stops the old one", async () => {
		const service = await ready();
		service.stopGate = deferred();
		const recreated = supervisor.recreate();
		await tick();
		const shutDown = supervisor.shutdown();
		service.stopGate.resolve();
		await Promise.all([recreated, shutDown]);
		assert.equal(services.length, 1);
		assert.equal(supervisor.service, undefined);
	});

	it("reports why OMP cannot be used when the service could not be built", async () => {
		createError = new Error("omp.extraArgs must be an array of strings");
		supervisor.initialize();
		await assert.rejects(supervisor.ensureService(), /^Error: omp\.extraArgs must be an array of strings$/);
	});

	it("reports OMP stopped, not missing, after shutdown", async () => {
		await ready();
		await supervisor.shutdown();
		await assert.rejects(supervisor.ensureService(), /OMP was stopped/);
	});

	it("does not run OMP in Restricted Mode and starts it once the workspace is trusted", async () => {
		workspace.isTrusted = false;
		supervisor.initialize();
		assert.equal(services.length, 0);
		assert.match(unavailable[0], /Restricted Mode/);
		assert.deepEqual(errors(), []);
		await assert.rejects(supervisor.ensureService(), /Restricted Mode/);

		workspace.isTrusted = true;
		stub.grantTrust();
		assert.equal(services.length, 1);
		assert.equal(services[0].starts.length, 1);
	});
});
