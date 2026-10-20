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
	let supervisor: ServiceSupervisor;

	const contexts = (key: string) =>
		stub
			.callsTo("commands.executeCommand")
			.filter(([command, name]) => command === "setContext" && name === key)
			.map(([, , value]) => value);
	const errors = () => stub.callsTo("window.showErrorMessage").map(([message]) => String(message));

	beforeEach(() => {
		stub.reset();
		logger = memoryLogger();
		services = [];
		createError = undefined;
		unavailable = [];
		consumed = [];
		shownLog = 0;
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
			resumeOptions: preferred => (preferred ? { resumeSessionFile: preferred } : undefined),
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
