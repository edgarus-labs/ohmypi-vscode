import * as assert from "node:assert/strict";
import type { ConnectionStatus, InteractionRequest, InteractionResponse, OmpServiceApi, PresentationRequest } from "../../src/omp/api";
import { deferred } from "../../src/shared/deferred";
import { InteractionController, type InteractionSurface, PresentationHandler } from "../../src/ui/interactions";
import type { PendingInteraction } from "../../src/webview/protocol";
import { type MemoryLogger, memoryLogger, tick } from "./helpers";
import { EventEmitter, stub, Uri } from "./stubs/vscode";

class FakeSurface implements InteractionSurface {
	visible = true;
	shown: PendingInteraction[] = [];
	closed: string[] = [];
	composer: string[] = [];
	reveals = 0;
	revealError: Error | undefined;

	showInteraction(pending: PendingInteraction): void {
		this.shown.push(pending);
	}

	closeInteraction(id: string): void {
		this.closed.push(id);
	}

	setComposerText(text: string): void {
		this.composer.push(text);
	}

	async reveal(): Promise<void> {
		this.reveals++;
		if (this.revealError) throw this.revealError;
	}
}

class FakeService {
	readonly requests = new EventEmitter<InteractionRequest>();
	readonly cancellations = new EventEmitter<string>();
	readonly presentations = new EventEmitter<PresentationRequest>();
	readonly answers: Array<[string, InteractionResponse]> = [];
	failWith: Error | undefined;
	readonly onInteractionRequest = this.requests.event;
	readonly onInteractionCancelled = this.cancellations.event;
	readonly onPresentation = this.presentations.event;
	readonly connections = new EventEmitter<ConnectionStatus>();
	readonly onDidChangeConnection = this.connections.event;

	respondInteraction(id: string, response: InteractionResponse): void {
		if (this.failWith) throw this.failWith;
		this.answers.push([id, response]);
	}

	get api(): OmpServiceApi {
		return this as unknown as OmpServiceApi;
	}
}

const confirm: InteractionRequest = { id: "c1", kind: "confirm", title: "Run rm?" };

describe("InteractionController", () => {
	let surface: FakeSurface;
	let service: FakeService;
	let logger: MemoryLogger;
	let controller: InteractionController;

	beforeEach(() => {
		stub.reset();
		surface = new FakeSurface();
		service = new FakeService();
		logger = memoryLogger();
		controller = new InteractionController(surface, logger);
		controller.setService(service.api);
	});

	afterEach(() => controller.dispose());

	it("shows a request inline and forwards the first answer once", () => {
		service.requests.fire(confirm);
		assert.deepEqual(
			controller.list().map(pending => pending.request.id),
			["c1"],
		);
		assert.deepEqual(surface.shown.map(pending => pending.request.id), ["c1"]);

		controller.respond("c1", { kind: "confirmed", confirmed: true });
		controller.respond("c1", { kind: "confirmed", confirmed: false });

		assert.deepEqual(service.answers, [["c1", { kind: "confirmed", confirmed: true }]]);
		assert.deepEqual(surface.closed, ["c1"]);
		assert.deepEqual(controller.list(), []);
	});

	it("keeps the request open and reports the error when the answer cannot be delivered", () => {
		service.requests.fire(confirm);
		service.failWith = new Error("OMP is not running");

		controller.respond("c1", { kind: "confirmed", confirmed: true });

		assert.deepEqual(surface.closed, []);
		assert.deepEqual(
			controller.list().map(pending => pending.request.id),
			["c1"],
		);
		const [message] = stub.callsTo("window.showErrorMessage")[0] ?? [];
		assert.match(String(message), /failed to send your answer: OMP is not running/);
		assert.match(logger.text("error"), /Failed to answer interaction c1/);

		service.failWith = undefined;
		controller.respond("c1", { kind: "confirmed", confirmed: false });
		assert.deepEqual(service.answers, [["c1", { kind: "confirmed", confirmed: false }]]);
		assert.deepEqual(surface.closed, ["c1"]);
	});

	it("ignores an answer that does not fit the request and keeps the request open", () => {
		service.requests.fire(confirm);
		service.requests.fire({ id: "s1", kind: "select", title: "Pick", options: [{ label: "a" }] });
		service.requests.fire({ id: "q1", kind: "ask", questions: [] });
		for (const [id, response] of [
			["c1", { kind: "value", value: "yes" }],
			["c1", { kind: "confirmed", confirmed: "yes" }],
			["c1", null],
			["s1", { kind: "value", value: "not offered" }],
			["s1", { kind: "confirmed", confirmed: true }],
			["q1", { kind: "answers", answers: "all" }],
			["q1", { kind: "approve" }],
		] as const) {
			controller.respond(id, response as unknown as InteractionResponse);
		}
		assert.deepEqual(service.answers, []);
		assert.deepEqual(
			controller.list().map(pending => pending.request.id),
			["c1", "s1", "q1"],
		);
		assert.equal(logger.text("warn").split("\n").filter(line => line.includes("does not fit")).length, 7, logger.text("warn"));

		controller.respond("s1", { kind: "value", value: "a" });
		controller.respond("c1", { kind: "cancelled" });
		controller.respond("q1", { kind: "answers", answers: [] });
		assert.deepEqual(service.answers, [
			["s1", { kind: "value", value: "a" }],
			["c1", { kind: "cancelled" }],
			["q1", { kind: "answers", answers: [] }],
		]);
	});

	it("records the expiry of a request with a timeout", () => {
		const before = Date.now();
		service.requests.fire({ ...confirm, timeoutMs: 5000 });
		const [pending] = controller.list();
		assert.ok(pending.expiresAt !== undefined && pending.expiresAt >= before + 5000);
	});

	it("closes a request OMP withdrew and ignores a late answer", () => {
		service.requests.fire(confirm);
		service.cancellations.fire("c1");
		controller.respond("c1", { kind: "confirmed", confirmed: true });
		assert.deepEqual(surface.closed, ["c1"]);
		assert.deepEqual(service.answers, []);
	});

	it("closes every open request when the service goes away", () => {
		service.requests.fire(confirm);
		service.requests.fire({ id: "s1", kind: "select", title: "Pick", options: [{ label: "a" }] });
		controller.setService(undefined);
		assert.deepEqual(surface.closed, ["c1", "s1"]);
		assert.deepEqual(controller.list(), []);
		service.requests.fire({ ...confirm, id: "c2" });
		assert.deepEqual(controller.list(), []);
	});

	it("notifies natively while the chat is hidden and reveals it on Show", async () => {
		surface.visible = false;
		stub.on("window.showInformationMessage", () => "Show");
		service.requests.fire(confirm);
		await tick();
		const [message, ...actions] = stub.callsTo("window.showInformationMessage")[0];
		assert.equal(message, "OMP needs your input: Run rm?");
		assert.deepEqual(actions, ["Show", "Answer here"]);
		assert.equal(surface.reveals, 1);
	});

	it("does not notify natively while the chat is visible", async () => {
		service.requests.fire(confirm);
		await tick();
		assert.deepEqual(stub.callsTo("window.showInformationMessage"), []);
	});

	it("answers a confirmation from a native quick pick", async () => {
		surface.visible = false;
		stub.on("window.showInformationMessage", () => "Answer here");
		stub.on("window.showQuickPick", () => ({ label: "Deny" }));
		service.requests.fire(confirm);
		await tick();
		assert.deepEqual(service.answers, [["c1", { kind: "confirmed", confirmed: false }]]);
		assert.deepEqual(surface.closed, ["c1"]);
	});

	it("answers an input request from a native input box", async () => {
		surface.visible = false;
		stub.on("window.showInformationMessage", () => "Answer here");
		stub.on("window.showInputBox", () => "token");
		service.requests.fire({ id: "i1", kind: "input", title: "Name?", placeholder: "name" });
		await tick();
		const [options] = stub.callsTo("window.showInputBox")[0] as [{ title: string; placeHolder?: string }];
		assert.equal(options.title, "Name?");
		assert.equal(options.placeHolder, "name");
		assert.deepEqual(service.answers, [["i1", { kind: "value", value: "token" }]]);
	});

	it("cancels the native picker when the request is answered inline", async () => {
		surface.visible = false;
		stub.on("window.showInformationMessage", () => "Answer here");
		let token: { isCancellationRequested: boolean } | undefined;
		stub.on("window.showQuickPick", (_items: unknown, _options: unknown, cancellation: { isCancellationRequested: boolean }) => {
			token = cancellation;
			return deferred<unknown>().promise;
		});
		service.requests.fire(confirm);
		await tick();
		assert.equal(token?.isCancellationRequested, false);
		controller.respond("c1", { kind: "confirmed", confirmed: true });
		assert.equal(token?.isCancellationRequested, true);
	});

	it("only offers Show for requests that need the chat", async () => {
		surface.visible = false;
		service.requests.fire({ id: "e1", kind: "editor", title: "Edit" });
		await tick();
		const [, ...actions] = stub.callsTo("window.showInformationMessage")[0];
		assert.deepEqual(actions, ["Show"]);
	});

	it("logs a native notification that fails", async () => {
		surface.visible = false;
		surface.revealError = new Error("view not registered");
		stub.on("window.showInformationMessage", () => "Show");
		service.requests.fire(confirm);
		await tick();
		await tick();
		assert.match(logger.text("error"), /Native notification for interaction c1 failed: Error: view not registered/);
	});
});

describe("PresentationHandler", () => {
	let surface: FakeSurface;
	let service: FakeService;
	let logger: MemoryLogger;
	let handler: PresentationHandler;

	beforeEach(() => {
		stub.reset();
		surface = new FakeSurface();
		service = new FakeService();
		logger = memoryLogger();
		handler = new PresentationHandler(surface, logger);
		handler.setService(service.api);
	});

	afterEach(() => handler.dispose());

	it("shows notifications at their level", async () => {
		service.presentations.fire({ kind: "notify", level: "error", message: "boom" });
		service.presentations.fire({ kind: "notify", level: "warning", message: "careful" });
		service.presentations.fire({ kind: "notify", level: "info", message: "fyi" });
		await tick();
		assert.deepEqual(stub.callsTo("window.showErrorMessage"), [["OMP: boom"]]);
		assert.deepEqual(stub.callsTo("window.showWarningMessage"), [["OMP: careful"]]);
		assert.deepEqual(stub.callsTo("window.showInformationMessage"), [["OMP: fyi"]]);
	});

	it("puts editor text into the composer", async () => {
		service.presentations.fire({ kind: "editorText", text: "draft" });
		await tick();
		assert.deepEqual(surface.composer, ["draft"]);
	});

	it("refuses to open a URL that is not http or https", async () => {
		for (const url of ["javascript:alert(1)", "file:///etc/passwd", "command:workbench.action.reloadWindow"]) {
			service.presentations.fire({ kind: "openUrl", url });
		}
		await tick();
		assert.equal(stub.callsTo("window.showWarningMessage").length, 3);
		assert.deepEqual(stub.callsTo("env.openExternal"), []);
		assert.deepEqual(stub.callsTo("window.showInformationMessage"), []);
	});

	it("opens a web URL exactly as OMP sent it, only after the user chooses Open", async () => {
		stub.on("window.showInformationMessage", () => undefined);
		service.presentations.fire({ kind: "openUrl", url: "https://example.com/login" });
		await tick();
		assert.deepEqual(stub.callsTo("env.openExternal"), []);

		stub.on("window.showInformationMessage", () => "Open");
		const url = "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcb&state=a%2Bb%26c";
		service.presentations.fire({ kind: "openUrl", url, instructions: "Sign in" });
		await tick();
		const [message, options] = stub.callsTo("window.showInformationMessage")[1] as [string, { modal: boolean; detail: string }];
		assert.equal(message, "OMP wants to open a URL in your browser.");
		assert.equal(options.modal, true);
		assert.equal(options.detail, `Sign in\n\n${url}`);
		assert.deepEqual(stub.callsTo("env.openExternal"), [[url]]);
	});

	it("creates, updates and removes status items by key", async () => {
		service.presentations.fire({ kind: "status", key: "git", text: "main" });
		service.presentations.fire({ kind: "status", key: "git", text: "dev" });
		await tick();
		assert.equal(stub.callsTo("window.createStatusBarItem").length, 1);
		const [item] = stub.callsTo("statusBarItem.show").at(-1) as [{ text: string }];
		assert.equal(item.text, "dev");
		service.presentations.fire({ kind: "status", key: "git" });
		await tick();
		assert.equal(stub.callsTo("statusBarItem.dispose").length, 1);
	});

	it("shows the tier router status in its short form", async () => {
		service.presentations.fire({ kind: "status", key: "tier", text: "tier: standard (0.91/0.07/0.02)" });
		await tick();
		const [item] = stub.callsTo("statusBarItem.show").at(-1) as [{ text: string; tooltip: string }];
		assert.equal(item.text, "router auto · standard");
		assert.equal(item.tooltip, "OMP: tier\ntier: standard (0.91/0.07/0.02)");
	});

	it("removes status items of the previous service when the service changes", async () => {
		service.presentations.fire({ kind: "status", key: "git", text: "main" });
		await tick();
		handler.setService(new FakeService().api);
		assert.equal(stub.callsTo("statusBarItem.dispose").length, 1);
		handler.setService(undefined);
		assert.equal(stub.callsTo("statusBarItem.dispose").length, 1);
	});

	it("removes status items when the OMP process stops or restarts", async () => {
		service.presentations.fire({ kind: "status", key: "git", text: "main" });
		await tick();
		service.connections.fire({ state: "ready", pid: 1 });
		assert.equal(stub.callsTo("statusBarItem.dispose").length, 0);
		service.connections.fire({ state: "restarting" });
		assert.equal(stub.callsTo("statusBarItem.dispose").length, 1);
	});

	it("logs a presentation that fails", async () => {
		stub.on("window.showInformationMessage", () => {
			throw new Error("dialog failed");
		});
		service.presentations.fire({ kind: "openUrl", url: "https://example.com" });
		await tick();
		assert.match(logger.text("error"), /Presentation openUrl failed: Error: dialog failed/);
	});
});
