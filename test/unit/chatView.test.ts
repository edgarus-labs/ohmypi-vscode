import * as assert from "node:assert/strict";
import * as path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type * as vscode from "vscode";
import type {
	OmpServiceApi,
	PresentationRequest,
	PromptOutcome,
	ProviderUsage,
	SessionSummary,
	SessionView,
	SlashCommandView,
	TranscriptItem,
} from "../../src/omp/api";
import { deferred } from "../../src/shared/deferred";
import { emptySessionView } from "../../src/shared/session";
import { type ChatHost, ChatView } from "../../src/ui/ChatView";
import type { HostMessage, RenderedReport, WebviewMessage } from "../../src/webview/protocol";
import { type MemoryLogger, memoryLogger } from "./helpers";
import { EventEmitter, stub, Uri } from "./stubs/vscode";

class FakeWebview {
	options: unknown;
	html = "";
	readonly cspSource = "vscode-resource:";
	readonly posted: HostMessage[] = [];
	private readonly received = new EventEmitter<WebviewMessage>();
	readonly onDidReceiveMessage = this.received.event;

	asWebviewUri(uri: Uri): Uri {
		return uri;
	}

	postMessage(message: HostMessage): Promise<boolean> {
		this.posted.push(message);
		return Promise.resolve(true);
	}

	receive(message: WebviewMessage): void {
		this.received.fire(message);
	}

	types(): string[] {
		return this.posted.map(message => message.type);
	}

	ofType<T extends HostMessage["type"]>(type: T): Array<Extract<HostMessage, { type: T }>> {
		return this.posted.filter((message): message is Extract<HostMessage, { type: T }> => message.type === type);
	}
}

interface FakeView {
	webview: FakeWebview;
	visible: boolean;
	onDidDispose: vscode.Event<void>;
	show(): void;
}

function fakeView(visible = true): FakeView {
	return { webview: new FakeWebview(), visible, onDidDispose: new EventEmitter<void>().event, show() {} };
}

interface FakeService {
	api: OmpServiceApi;
	sessions: EventEmitter<SessionView>;
	items: EventEmitter<TranscriptItem>;
	prompt: (text: string, pendingId?: string) => Promise<PromptOutcome>;
	listSessions: () => Promise<SessionSummary[]>;
	abort: () => Promise<void>;
	switched: string[];
	session: SessionView;
	/** Answer of `addPendingPrompt`; `undefined` acts as a busy agent. */
	pendingId: string | undefined;
	discarded: string[];
	presentations: EventEmitter<PresentationRequest>;
	statuses: Map<string, string>;
	getUsage: () => Promise<ProviderUsage[]>;
}

function fakeService(): FakeService {
	const sessions = new EventEmitter<SessionView>();
	const items = new EventEmitter<TranscriptItem>();
	const fake: FakeService = {
		sessions,
		items,
		prompt: () => Promise.resolve({ status: "completed", sessionSettled: true }),
		listSessions: () => Promise.resolve([]),
		abort: () => Promise.resolve(),
		switched: [],
		session: emptySessionView(),
		pendingId: "pending-1",
		discarded: [],
		presentations: new EventEmitter<PresentationRequest>(),
		statuses: new Map(),
		getUsage: () => Promise.resolve([]),
		api: undefined as unknown as OmpServiceApi,
	};
	fake.api = {
		cwd: path.resolve("/work/repo"),
		connection: { state: "ready" },
		get session() {
			return fake.session;
		},
		transcript: [],
		onDidChangeTranscriptItem: items.event,
		onDidResetTranscript: new EventEmitter().event,
		onDidChangeSession: sessions.event,
		onDidChangeConnection: new EventEmitter().event,
		onPresentation: fake.presentations.event,
		get statuses() {
			return fake.statuses;
		},
		getUsage: () => fake.getUsage(),
		addPendingPrompt: (text: string, imageCount: number) => {
			const id = fake.pendingId;
			if (id !== undefined) items.fire({ kind: "user", id, text, ...(imageCount > 0 ? { imageCount } : {}), pending: true });
			return id;
		},
		discardPendingPrompt: (id: string) => {
			fake.discarded.push(id);
		},
		prompt: (text: string, _mode: unknown, _images: unknown, pendingId?: string) => fake.prompt(text, pendingId),
		listSessions: () => fake.listSessions(),
		abort: () => fake.abort(),
		switchSession: async (file: string) => {
			fake.switched.push(file);
		},
	} as unknown as OmpServiceApi;
	return fake;
}

/** Lets fire-and-forget message handling and its promise chains run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await nextTurn();
}

const summary = (name: string): SessionSummary => ({ path: path.resolve(`/sessions/${name}.jsonl`), modified: 1, size: 1, title: name });

describe("ChatView", () => {
	let logger: MemoryLogger;
	let service: FakeService;
	let host: ChatHost & { opened: unknown[]; diffs: unknown[]; dismissed: string[] };
	let chat: ChatView;

	function create(testHooks = false): ChatView {
		chat = new ChatView(Uri.file(path.resolve("/ext")) as never, "omp.chat", logger, host, testHooks);
		chat.setService(service.api);
		return chat;
	}

	function resolve(view: FakeView): FakeView {
		chat.resolveWebviewView(view as unknown as vscode.WebviewView);
		return view;
	}

	async function ready(view: FakeView = fakeView()): Promise<FakeWebview> {
		resolve(view).webview.receive({ type: "ready" });
		await settle();
		return view.webview;
	}

	beforeEach(() => {
		stub.reset();
		logger = memoryLogger();
		service = fakeService();
		host = {
			opened: [],
			diffs: [],
			dismissed: ["todos:old"],
			dismissedTodos: () => host.dismissed,
			dismissTodos: async key => {
				host.dismissed.unshift(key);
			},
			ensureService: async () => service.api,
			pendingInteractions: () => [],
			respond: () => {},
			openFile: async (filePath, line) => {
				host.opened.push([filePath, line]);
			},
			openToolDiff: async (toolCallId, file) => {
				host.diffs.push([toolCallId, file]);
			},
		};
		create();
	});

	afterEach(() => chat.dispose());

	describe("before the webview is ready", () => {
		it("posts nothing, then resets and replays composer text, attachments and notices", async () => {
			const view = resolve(fakeView());
			chat.setComposerText("draft");
			chat.addFiles([Uri.file(path.resolve("/work/repo/a.ts"))] as never);
			chat.notice("error", "Abort failed: boom");
			assert.deepEqual(view.webview.posted, []);
			view.webview.receive({ type: "ready" });
			await settle();
			assert.deepEqual(view.webview.types(), ["reset", "setComposer", "addAttachments", "notice", "recentSessions"]);
			assert.deepEqual(view.webview.ofType("notice"), [{ type: "notice", level: "error", text: "Abort failed: boom" }]);
			view.webview.receive({ type: "ready" });
			await settle();
			assert.equal(view.webview.ofType("notice").length, 1, "queued notices are posted once");
		});

		it("shows a failure that happens while the view reloads once the new webview is ready", async () => {
			await ready();
			const failure = deferred<OmpServiceApi>();
			host.ensureService = () => failure.promise;
			const old = chat as unknown as { onMessage(message: WebviewMessage): Promise<void> };
			const handled = old.onMessage({ type: "abort" });
			const reloaded = resolve(fakeView());
			failure.reject(new Error("boom"));
			await handled;
			assert.deepEqual(reloaded.webview.posted, []);
			assert.deepEqual(stub.callsTo("window.showErrorMessage"), []);
			reloaded.webview.receive({ type: "ready" });
			await settle();
			assert.deepEqual(reloaded.webview.ofType("notice"), [{ type: "notice", level: "error", text: "Abort failed: boom" }]);
		});
	});

	describe("reset", () => {
		it("carries the transcript state and pending interactions", async () => {
			const pending = { request: { id: "i1", kind: "confirm", title: "Go?", message: "" } } as never;
			host.pendingInteractions = () => [pending];
			const [reset] = (await ready()).ofType("reset");
			assert.deepEqual(reset.interactions, [pending]);
			assert.equal(reset.cwd, service.api.cwd);
			assert.deepEqual(reset.connection, { state: "ready" });
		});

		it("tells the webview whether to post render reports", async () => {
			assert.equal((await ready()).ofType("reset")[0].testHooks, false);
			chat.dispose();
			create(true);
			assert.equal((await ready()).ofType("reset")[0].testHooks, true);
		});

		it("ignores render reports unless test hooks are on", async () => {
			const lastRendered = (): RenderedReport | undefined => chat.lastRendered;
			const webview = await ready();
			webview.receive({ type: "rendered", counts: { user: 1 }, interactions: [] });
			await settle();
			assert.equal(lastRendered(), undefined);
			chat.dispose();
			create(true);
			const hooked = await ready();
			hooked.receive({ type: "rendered", counts: { user: 1 }, interactions: [] });
			await settle();
			assert.deepEqual(lastRendered()?.counts, { user: 1 });
		});
	});

	describe("commands", () => {
		it("runs commands the webview may request", async () => {
			const webview = await ready();
			webview.receive({ type: "command", command: "omp.restart" });
			await settle();
			assert.deepEqual(stub.callsTo("commands.executeCommand"), [["omp.restart"]]);
		});

		it("refuses any other command id", async () => {
			const webview = await ready();
			webview.receive({ type: "command", command: "workbench.action.files.delete" } as unknown as WebviewMessage);
			await settle();
			assert.deepEqual(stub.callsTo("commands.executeCommand"), []);
			assert.match(logger.text("warn"), /workbench\.action\.files\.delete/);
		});
	});

	describe("recent sessions", () => {
		it("opens only sessions it offered", async () => {
			service.listSessions = async () => [summary("a")];
			const webview = await ready();
			assert.deepEqual(webview.ofType("recentSessions")[0].sessions.map(session => session.title), ["a"]);
			webview.receive({ type: "openSession", path: path.resolve("/etc/other.jsonl") });
			await settle();
			assert.deepEqual(service.switched, []);
			assert.match(logger.text("warn"), /not offered/);
			webview.receive({ type: "openSession", path: summary("a").path });
			await settle();
			assert.deepEqual(service.switched, [summary("a").path]);
		});

		it("never lets an older, slower listing overwrite a newer one", async () => {
			const listings = [deferred<SessionSummary[]>(), deferred<SessionSummary[]>()];
			let call = 0;
			service.listSessions = () => listings[call++].promise;
			const webview = await ready();
			service.sessions.fire({ ...emptySessionView(), sessionFile: path.resolve("/sessions/current.jsonl") });
			listings[1].resolve([summary("new")]);
			await settle();
			listings[0].resolve([summary("old")]);
			await settle();
			assert.deepEqual(
				chat.offeredSessions.map(session => session.title),
				["new"],
			);
			assert.equal(webview.ofType("recentSessions").length, 1);
		});
	});

	describe("files and diffs", () => {
		it("opens files and tool diffs through the host", async () => {
			const webview = await ready();
			webview.receive({ type: "openFile", path: "src/a.ts", line: 3 });
			webview.receive({ type: "openDiff", toolCallId: "t1" });
			await settle();
			assert.deepEqual(host.opened, [["src/a.ts", 3]]);
			assert.deepEqual(host.diffs, [["t1", undefined]]);
		});

		it("opens the diff of one file of a tool call and ignores a file that is not text", async () => {
			const webview = await ready();
			webview.receive({ type: "openDiff", toolCallId: "t1", path: "src/b.ts" });
			webview.receive({ type: "openDiff", toolCallId: "t1", path: 5 } as unknown as WebviewMessage);
			await settle();
			assert.deepEqual(host.diffs, [["t1", "src/b.ts"]]);
			assert.match(logger.text("warn"), /diff/);
		});

		it("opens web and mail links in the browser", async () => {
			const webview = await ready();
			webview.receive({ type: "openExternal", url: "https://example.com/a?b=1" });
			webview.receive({ type: "openExternal", url: "mailto:me@example.com" });
			await settle();
			assert.deepEqual(
				stub.callsTo("env.openExternal").map(([uri]) => String(uri)),
				["https://example.com/a?b=1", "mailto:me@example.com"],
			);
		});

		it("refuses to open links that are not web or mail links", async () => {
			const webview = await ready();
			for (const url of ["javascript:alert(1)", "file:///etc/passwd", "command:workbench.action.files.delete", "not a url", 7]) {
				webview.receive({ type: "openExternal", url } as unknown as WebviewMessage);
			}
			await settle();
			assert.deepEqual(stub.callsTo("env.openExternal"), []);
			assert.equal(logger.text("warn").split("\n").filter(line => line.includes("Not opening")).length, 5, logger.text("warn"));
		});

		it("reports a failed open as an error notice", async () => {
			host.openFile = async () => {
				throw new Error("ENOENT: no such file");
			};
			host.openToolDiff = async () => {
				throw new Error("diff rejected");
			};
			const webview = await ready();
			webview.receive({ type: "openFile", path: "gone.ts" });
			webview.receive({ type: "openDiff", toolCallId: "t1" });
			await settle();
			assert.deepEqual(
				webview.ofType("notice").map(notice => notice.text),
				["Open file failed: ENOENT: no such file", "Open diff failed: diff rejected"],
			);
		});

		it("reports failures with a native error while the view is hidden", async () => {
			service.abort = () => Promise.reject(new Error("not running"));
			const view = fakeView();
			const webview = await ready(view);
			view.visible = false;
			webview.receive({ type: "abort" });
			await settle();
			assert.deepEqual(webview.ofType("notice"), []);
			assert.deepEqual(stub.callsTo("window.showErrorMessage"), [["OMP: Abort failed: not running"]]);
		});
	});

	describe("send", () => {
		const send = (id: string): WebviewMessage => ({ type: "send", id, text: "hello", mode: "auto", includeContext: false, attachments: [] });

		it("confirms a prompt as soon as OMP accepted it, before it completes", async () => {
			const outcome = deferred<PromptOutcome>();
			const prompts: string[] = [];
			service.prompt = text => {
				prompts.push(text);
				return outcome.promise;
			};
			const webview = await ready();
			webview.receive(send("s1"));
			await settle();
			assert.deepEqual(prompts, ["hello"]);
			assert.deepEqual(webview.ofType("sendResult"), [{ type: "sendResult", id: "s1", ok: true }]);
			outcome.resolve({ status: "completed", sessionSettled: true });
			await settle();
			assert.deepEqual(webview.ofType("notice"), []);
		});

		it("returns the error when OMP is not running, without a second notice", async () => {
			service.prompt = () => Promise.reject(new Error("OMP is not running (restarting)"));
			const webview = await ready();
			webview.receive(send("s2"));
			await settle();
			assert.deepEqual(webview.ofType("sendResult"), [{ type: "sendResult", id: "s2", ok: false, error: "OMP is not running (restarting)" }]);
			assert.deepEqual(webview.ofType("notice"), []);
			assert.match(logger.text("error"), /OMP is not running/);
		});

		it("returns the error when OMP cannot be started", async () => {
			host.ensureService = () => Promise.reject(new Error("OMP executable not found"));
			const webview = await ready();
			webview.receive(send("s3"));
			await settle();
			assert.deepEqual(webview.ofType("sendResult"), [{ type: "sendResult", id: "s3", ok: false, error: "OMP executable not found" }]);
		});

		it("reports a prompt that fails after OMP accepted it", async () => {
			const outcome = deferred<PromptOutcome>();
			service.prompt = () => outcome.promise;
			const webview = await ready();
			webview.receive(send("s4"));
			await settle();
			outcome.reject(new Error("connection lost"));
			await settle();
			assert.deepEqual(webview.ofType("sendResult"), [{ type: "sendResult", id: "s4", ok: true }]);
			assert.deepEqual(
				webview.ofType("notice").map(notice => notice.text),
				["Prompt failed: connection lost"],
			);
		});

		it("posts the user's message as a pending item before OMP starts", async () => {
			const started = deferred<OmpServiceApi>();
			host.ensureService = () => started.promise;
			const pendingIds: Array<string | undefined> = [];
			service.prompt = (_text, pendingId) => {
				pendingIds.push(pendingId);
				return Promise.resolve({ status: "completed", sessionSettled: true });
			};
			const webview = await ready();
			webview.receive({ type: "send", id: "s5", text: "hello", mode: "auto", includeContext: false, attachments: [{ id: "a1", kind: "file", path: path.resolve("/work/repo/src/a.ts"), label: "a.ts" }] });
			await settle();
			const text = `hello\n\nAttached: @${path.join("src", "a.ts")}`;
			assert.deepEqual(webview.ofType("item"), [{ type: "item", item: { kind: "user", id: "pending-1", text, pending: true } }]);
			started.resolve(service.api);
			await settle();
			assert.deepEqual(pendingIds, ["pending-1"]);
		});

		it("drops the pending item when OMP cannot be started", async () => {
			host.ensureService = () => Promise.reject(new Error("OMP executable not found"));
			const webview = await ready();
			webview.receive(send("s6"));
			await settle();
			assert.deepEqual(service.discarded, ["pending-1"]);
		});

		it("sends without a pending item while the agent is busy", async () => {
			service.pendingId = undefined;
			const pendingIds: Array<string | undefined> = [];
			service.prompt = (_text, pendingId) => {
				pendingIds.push(pendingId);
				return Promise.resolve({ status: "completed", sessionSettled: true });
			};
			const webview = await ready();
			webview.receive(send("s7"));
			await settle();
			assert.deepEqual(webview.ofType("item"), []);
			assert.deepEqual(pendingIds, [undefined]);
		});

		describe("editor context", () => {
			const command = (name: string, aliases: string[] = []): SlashCommandView => ({ name, source: "builtin", aliases, subcommands: [] });

			async function sent(text: string, commands: readonly SlashCommandView[]): Promise<string> {
				service.session = { ...emptySessionView(), commands };
				const prompts: string[] = [];
				service.prompt = prompt => {
					prompts.push(prompt);
					return Promise.resolve({ status: "completed", sessionSettled: true });
				};
				const webview = await ready();
				webview.receive({ type: "send", id: "c", text, mode: "auto", includeContext: true, attachments: [] });
				await settle();
				assert.equal(prompts.length, 1);
				return prompts[0];
			}

			it("goes before ordinary text", async () => {
				assert.match(await sent("hello", [command("rules")]), /^<editor-context>[\s\S]*\n\nhello$/);
			});

			it("is left out of a known slash command or alias so OMP runs the command", async () => {
				assert.equal(await sent("/rules", [command("rules")]), "/rules");
				chat.dispose();
				create();
				assert.equal(await sent("/m gpt", [command("model", ["m"])]), "/m gpt");
			});

			it("stays with text naming no known command", async () => {
				assert.match(await sent("/etc/hosts is broken", [command("rules")]), /^<editor-context>/);
			});

			it("is left out of any slash command while OMP has not listed its commands", async () => {
				assert.equal(await sent("/rules", []), "/rules");
				chat.dispose();
				create();
				assert.match(await sent("/ not a command", []), /^<editor-context>/);
			});
		});
	});

	describe("statuses, usage and todo dismissal", () => {
		it("replays the statuses in the reset and posts every change", async () => {
			service.statuses.set("tier", "tier-router: paused");
			const webview = await ready();
			const [reset] = webview.ofType("reset");
			assert.deepEqual(reset.statuses, [{ key: "tier", text: "tier-router: paused" }]);
			assert.deepEqual(reset.dismissedTodos, ["todos:old"]);
			service.statuses.delete("tier");
			service.presentations.fire({ kind: "status", key: "tier" });
			service.presentations.fire({ kind: "notify", message: "hi", level: "info" });
			assert.deepEqual(webview.ofType("statuses"), [{ type: "statuses", statuses: [] }]);
		});

		it("answers a usage request with the providers or with why usage is unavailable", async () => {
			const providers: ProviderUsage[] = [{ provider: "Anthropic", limits: [] }];
			service.getUsage = async () => providers;
			const webview = await ready();
			webview.receive({ type: "loadUsage", id: "u1" });
			await settle();
			service.getUsage = () => Promise.reject(new Error("OMP printed no usage report"));
			webview.receive({ type: "loadUsage", id: "u2" });
			await settle();
			assert.deepEqual(webview.ofType("usage"), [
				{ type: "usage", id: "u1", providers },
				{ type: "usage", id: "u2", error: "OMP printed no usage report" },
			]);
			assert.match(logger.text("error"), /Loading usage from OMP failed: Error: OMP printed no usage report/);
		});

		it("toggles the usage popup once the webview is ready", async () => {
			const view = resolve(fakeView());
			chat.toggleUsage();
			view.webview.receive({ type: "ready" });
			await settle();
			chat.toggleUsage();
			assert.equal(view.webview.ofType("toggleUsage").length, 2);
		});

		it("resumes the tier router with /tier-auto and says when that failed", async () => {
			const sent: string[] = [];
			service.prompt = async text => {
				sent.push(text);
				throw new Error("busy");
			};
			const webview = await ready();
			webview.receive({ type: "resumeTierRouter" });
			await settle();
			assert.deepEqual(sent, ["/tier-auto"]);
			assert.deepEqual(webview.ofType("notice"), [{ type: "notice", level: "error", text: "Resume tier router failed: busy" }]);
		});

		it("remembers a closed todo list and ignores a key that is not text", async () => {
			const webview = await ready();
			webview.receive({ type: "dismissTodos", key: "todos:new" });
			webview.receive({ type: "dismissTodos", key: 7 } as unknown as WebviewMessage);
			await settle();
			assert.deepEqual(host.dismissed, ["todos:new", "todos:old"]);
			assert.match(logger.text("warn"), /todo/);
		});
	});
});
