import * as assert from "node:assert/strict";
import * as path from "node:path";
import { VsCodeHostTools } from "../../src/vscode/hostTools/VsCodeHostTools";
import { tick } from "./helpers";
import { debug, stub, TaskScope, Uri, workspace } from "./stubs/vscode";

interface FakeSession {
	readonly id: string;
	readonly name: string;
	customRequest(command: string, args?: unknown): Promise<unknown>;
}

interface FakeTracker {
	onWillReceiveMessage(message: unknown): void;
	onDidSendMessage(message: unknown): void;
	onExit(): void;
}

const stoppedEvent = (threadId: number, reason: string) => ({ type: "event", event: "stopped", body: { reason, threadId } });

describe("VS Code host tools", () => {
	const cwd = path.resolve("/work/repo");
	let tools: VsCodeHostTools;
	const invoke = (name: string, args: Record<string, unknown>) => tools.invoke(name, args, new AbortController().signal);

	beforeEach(() => {
		stub.reset();
		tools = new VsCodeHostTools(() => cwd);
	});
	afterEach(() => tools.dispose());

	it("offers only vscode_ tools whose schemas reject unknown arguments", () => {
		assert.ok(tools.definitions.length > 0);
		for (const definition of tools.definitions) {
			assert.match(definition.name, /^vscode_[a-z_]+$/);
			assert.equal(definition.parameters.type, "object");
			assert.equal(definition.parameters.additionalProperties, false);
		}
	});

	it("rejects an unknown tool", async () => {
		await assert.rejects(invoke("vs_build", {}), { message: "Unknown tool: vs_build" });
	});

	it("rejects a path outside the workspace before touching it", async () => {
		const outside = path.resolve("/etc/hosts");
		await assert.rejects(invoke("vscode_read_document", { path: outside }), { message: `'path' must be inside the workspace (${cwd}): ${outside}` });
		assert.deepEqual(stub.callsTo("workspace.fs.stat"), []);
	});

	describe("vscode_find_commands", () => {
		beforeEach(() => {
			stub.on("commands.getCommands", () => [
				"workbench.action.files.save",
				"editor.action.formatSelection",
				"editor.action.formatDocument",
				"format.all",
				"formatter.pick",
				"git.commit",
			]);
		});

		it("lists ids containing the filter, ignoring case, prefix matches and shorter ids first", async () => {
			assert.equal(
				await invoke("vscode_find_commands", { filter: "FORMAT" }),
				"format.all\nformatter.pick\neditor.action.formatDocument\neditor.action.formatSelection",
			);
			assert.deepEqual(stub.callsTo("commands.getCommands"), [[true]]);
		});

		it("returns at most max ids", async () => {
			assert.equal(await invoke("vscode_find_commands", { filter: "format", max: 2 }), "format.all\nformatter.pick");
		});

		it("says so when nothing matches", async () => {
			assert.equal(await invoke("vscode_find_commands", { filter: "zzz" }), "No commands match 'zzz'.");
		});
	});

	describe("vscode_execute_command", () => {
		it("runs a command that getCommands does not list yet, since executeCommand activates its extension", async () => {
			stub.on("commands.getCommands", () => []);
			stub.on("commands.executeCommand", () => undefined);
			assert.equal(await invoke("vscode_execute_command", { command: "lazy.ext.run" }), "Executed lazy.ext.run.");
			assert.deepEqual(stub.callsTo("commands.executeCommand"), [["lazy.ext.run"]]);
		});

		it("points to vscode_find_commands when VS Code reports the command as not found", async () => {
			stub.on("commands.executeCommand", () => {
				throw new Error("command 'no.such' not found");
			});
			await assert.rejects(invoke("vscode_execute_command", { command: "no.such" }), {
				message: "Unknown command 'no.such'. Use vscode_find_commands to look up command ids.",
			});
		});

		it("propagates any other failure unchanged", async () => {
			stub.on("commands.executeCommand", () => {
				throw new Error("boom");
			});
			await assert.rejects(invoke("vscode_execute_command", { command: "some.cmd" }), { message: "boom" });
		});
	});

	describe("vscode_debug", () => {
		const frames = { stackFrames: [{ id: 1, name: "main", line: 3, source: { path: "/work/repo/app.js" } }] };
		const resuming = new Set(["continue", "next", "stepIn", "stepOut"]);
		let session: FakeSession;
		let requests: string[];
		let tracker: FakeTracker;

		beforeEach(() => {
			requests = [];
			session = {
				id: "s1",
				name: "Launch app",
				customRequest: async command => {
					requests.push(command);
					if (resuming.has(command)) tracker.onDidSendMessage(stoppedEvent(7, "step"));
					return command === "stackTrace" ? frames : {};
				},
			};
			const [[, factory]] = stub.callsTo("debug.registerDebugAdapterTrackerFactory") as Array<
				[string, { createDebugAdapterTracker(s: FakeSession): FakeTracker }]
			>;
			tracker = factory.createDebugAdapterTracker(session);
			debug.activeDebugSession = session;
			tracker.onDidSendMessage(stoppedEvent(7, "breakpoint"));
		});

		const steps = [
			["continue", "workbench.action.debug.continue", "continue"],
			["step_over", "workbench.action.debug.stepOver", "next"],
			["step_into", "workbench.action.debug.stepInto", "stepIn"],
			["step_out", "workbench.action.debug.stepOut", "stepOut"],
		] as const;
		for (const [action, command, request] of steps) {
			it(`runs ${action} through ${command} on the stopped thread, so VS Code's views follow the debuggee`, async () => {
				stub.on("commands.executeCommand", () => {
					tracker.onWillReceiveMessage({ type: "request", command: request, arguments: { threadId: 7 } });
					tracker.onDidSendMessage(stoppedEvent(7, "step"));
				});
				assert.equal(await invoke("vscode_debug", { action }), "Debugger: stopped (step) in Launch app\nLocation: main at /work/repo/app.js:3");
				assert.deepEqual(stub.callsTo("commands.executeCommand"), [[command, undefined, { sessionId: "s1", threadId: "thread:s1:7" }]]);
				assert.deepEqual(requests, ["stackTrace"]);
			});
		}

		it("stop waits for the debug session to end before reporting the state", async () => {
			const result = invoke("vscode_debug", { action: "stop" });
			await tick();
			tracker.onExit();
			assert.equal(await result, "Debugger: not running.");
			assert.deepEqual(stub.callsTo("debug.stopDebugging"), [[]]);
			assert.deepEqual(requests, []);
		});

		it("stops requesting variables once the locals cap is reached", async () => {
			const many = Array.from({ length: 500 }, (_, i) => ({ name: `v${i}`, value: "1" }));
			const variableRequests: unknown[] = [];
			session.customRequest = async (command, args) => {
				if (command === "stackTrace") return frames;
				if (command === "scopes") return { scopes: [{ variablesReference: 1 }, { variablesReference: 2 }] };
				if (command === "variables") {
					variableRequests.push(args);
					return { variables: many };
				}
				return {};
			};
			await invoke("vscode_debug_inspect", { kind: "locals" });
			assert.equal(variableRequests.length, 1);
		});
	});

	describe("vscode_debug start with a named launch configuration", () => {
		const folderA = { uri: Uri.file(path.resolve("/work/a")), name: "a", index: 0 };
		const folderB = { uri: Uri.file(path.resolve("/work/b")), name: "b", index: 1 };
		const launch = (name: string) => ({ name, type: "node", request: "launch" });
		/** `launch` settings per level: folder `launch.json` by folder name, the workspace file and user settings. */
		const defineLaunch = (levels: { folders?: Record<string, unknown>; workspace?: unknown; user?: unknown }, key = "configurations") => {
			stub.on("workspaceConfiguration.inspect", (fullKey: string, scope: Uri | undefined) => {
				if (fullKey !== `launch.${key}`) return { key: fullKey };
				const folder = [folderA, folderB].find(candidate => candidate.uri.toString() === scope?.toString());
				return {
					key: fullKey,
					workspaceFolderValue: folder ? levels.folders?.[folder.name] : undefined,
					workspaceValue: levels.workspace,
					globalValue: levels.user,
				};
			});
		};

		beforeEach(() => {
			workspace.workspaceFolders = [folderA, folderB];
			stub.on("debug.startDebugging", () => {
				const [[onTerminated]] = stub.callsTo("debug.onDidTerminateDebugSession") as Array<[(session: { id: string }) => void]>;
				onTerminated({ id: "s9" });
				return true;
			});
		});

		it("starts it in the folder whose own launch.json defines it", async () => {
			stub.config.set("launch.configurations", [launch("Debug B")]);
			defineLaunch({ folders: { b: [launch("Debug B")] } });
			assert.equal(await invoke("vscode_debug", { action: "start", configuration: "Debug B" }), "Debugger: not running (the debug session ended).");
			assert.deepEqual(stub.callsTo("debug.startDebugging"), [[folderB, "Debug B", { noDebug: false }]]);
		});

		it("starts one from the workspace file as a configuration for the current platform, without a folder", async () => {
			const configuration = {
				...launch("Debug all"),
				program: "app.js",
				windows: { program: "app.exe" },
				osx: { program: "app.mac" },
				linux: { program: "app.linux" },
			};
			stub.config.set("launch.configurations", [configuration]);
			defineLaunch({ workspace: [configuration] });
			await invoke("vscode_debug", { action: "start", configuration: "Debug all", noDebug: true });
			const program = process.platform === "win32" ? "app.exe" : process.platform === "darwin" ? "app.mac" : "app.linux";
			assert.deepEqual(stub.callsTo("debug.startDebugging"), [[undefined, { ...configuration, program }, { noDebug: true }]]);
		});

		it("starts one from user settings without a folder", async () => {
			stub.config.set("launch.configurations", [launch("Mine")]);
			defineLaunch({ user: [launch("Mine")] });
			await invoke("vscode_debug", { action: "start", configuration: "Mine" });
			assert.deepEqual(stub.callsTo("debug.startDebugging"), [[undefined, launch("Mine"), { noDebug: false }]]);
		});

		it("refuses a compound from the workspace file, which VS Code cannot start by name from an extension", async () => {
			const compound = { name: "Both", configurations: ["Debug A", "Debug B"] };
			stub.config.set("launch.compounds", [compound]);
			defineLaunch({ workspace: [compound] }, "compounds");
			await assert.rejects(invoke("vscode_debug", { action: "start", configuration: "Both" }), {
				message:
					"'Both' is a compound launch configuration in the workspace file; VS Code lets extensions start compounds only from a folder's launch.json. Start it from the Run and Debug view.",
			});
			assert.deepEqual(stub.callsTo("debug.startDebugging"), []);
		});
	});

	describe("vscode_tasks", () => {
		const folderA = { uri: Uri.file(path.resolve("/work/a")), name: "a", index: 0 };
		const folderB = { uri: Uri.file(path.resolve("/work/b")), name: "b", index: 1 };
		const task = (name: string, scope: unknown) => ({ name, source: "Workspace", scope, isBackground: false, group: undefined });
		const run = (name: string, signal = new AbortController().signal) => tools.invoke("vscode_tasks", { action: "run", name }, signal);

		it("adds the folder, or user or workspace, to labels several tasks share, and runs the task with the given label", async () => {
			const buildB = task("build", folderB);
			const tasks = [task("build", folderA), buildB, task("build", TaskScope.Global), task("build", TaskScope.Workspace), task("lint", folderA)];
			stub.on("tasks.fetchTasks", () => tasks);
			assert.equal(
				await invoke("vscode_tasks", {}),
				"Workspace: build (a)\nWorkspace: build (b)\nWorkspace: build (user)\nWorkspace: build (workspace)\nWorkspace: lint",
			);
			const execution = {};
			stub.on("tasks.executeTask", () => execution);
			const result = run("Workspace: build (b)");
			await tick();
			stub.endTaskProcess({ execution, exitCode: 0 });
			assert.equal(await result, "Task Workspace: build (b) finished with exit code 0.\nProblems: 0 error(s), 0 warning(s).");
			assert.deepEqual(stub.callsTo("tasks.executeTask"), [[buildB]]);
			await assert.rejects(run("Workspace: build"), {
				message:
					"Several tasks are named 'Workspace: build': Workspace: build (a), Workspace: build (b), Workspace: build (user), Workspace: build (workspace); pass the label.",
			});
		});

		it("terminates the running task when the call is cancelled", async () => {
			let terminated = 0;
			const execution = { terminate: () => terminated++ };
			stub.on("tasks.fetchTasks", () => [task("test", folderA)]);
			stub.on("tasks.executeTask", () => execution);
			const controller = new AbortController();
			const result = run("test", controller.signal);
			await tick();
			controller.abort(new Error("cancelled"));
			await assert.rejects(result, /cancelled/);
			stub.endTask({ execution });
			assert.equal(terminated, 1);
		});

		it("does not start the task when the call is cancelled while the tasks load", async () => {
			let loaded = (_tasks: unknown[]) => {};
			stub.on("tasks.fetchTasks", () => new Promise(resolve => (loaded = resolve)));
			const controller = new AbortController();
			const result = run("test", controller.signal);
			await tick();
			controller.abort(new Error("cancelled"));
			loaded([task("test", folderA)]);
			await assert.rejects(result, /cancelled/);
			assert.deepEqual(stub.callsTo("tasks.executeTask"), []);
		});
	});
});
