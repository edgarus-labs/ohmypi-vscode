import * as path from "node:path";
import * as vscode from "vscode";
import type { HostTools } from "../../omp/api";
import { errorMessage } from "../../shared/errors";
import { isRecord } from "../../shared/guards";
import { exists, workspaceRoots } from "../workspaceFiles";
import { ToolArguments } from "./arguments";
import { type DebugOutcome, DebugSessions, type DebugStop } from "./debugSessions";
import { BREAKPOINT_ACTIONS, DEBUG_ACTIONS, INSPECT_KINDS, SEVERITIES, TASK_ACTIONS, TOOL_DEFINITIONS, type ToolName } from "./definitions";
import * as format from "./format";
import { planLineEdit, splitLines } from "./lineEdits";

type Handler = (args: ToolArguments, signal: AbortSignal) => Promise<string>;
type ResumeAction = "continue" | "step_into" | "step_over" | "step_out";

const DEFAULT_DIAGNOSTICS = 100;
const DEFAULT_COMMANDS = 50;
const RESUME_WAIT_MS = 30_000;
const PAUSE_WAIT_MS = 30_000;
/** How long `stop` waits for the debug sessions to end. */
const STOP_WAIT_MS = 10_000;
/** How long `start` waits for the debuggee to stop (stop on entry, an early breakpoint) once it launched. */
const START_GRACE_MS = 3_000;
const MAX_STACK_FRAMES = 100;
const MAX_LOCALS = 500;
/** `vscode.DiagnosticSeverity` values in order. */
const SEVERITY_NAMES: readonly format.Severity[] = ["error", "warning", "info", "hint"];
/**
 * The workbench commands that resume a thread. They tell VS Code's debug views that the debuggee runs again;
 * a bare `continue` or `next` request through `customRequest` leaves them showing the old stop.
 */
const RESUME_COMMANDS: Record<ResumeAction, string> = {
	continue: "workbench.action.debug.continue",
	step_into: "workbench.action.debug.stepInto",
	step_over: "workbench.action.debug.stepOver",
	step_out: "workbench.action.debug.stepOut",
};
/** The key of a launch configuration's overrides for this platform, which VS Code applies to the named ones it starts. */
const PLATFORM_KEY = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";

function displayPath(uri: vscode.Uri): string {
	return uri.scheme === "file" ? uri.fsPath : uri.toString();
}

function samePath(a: string, b: string): boolean {
	return path.relative(a, b) === "";
}

function findOpenDocument(file: string): vscode.TextDocument | undefined {
	return vscode.workspace.textDocuments.find(document => document.uri.scheme === "file" && samePath(document.uri.fsPath, file));
}

async function openFromDisk(file: string): Promise<vscode.TextDocument> {
	if (!(await exists(file))) throw new Error(`File not found: ${file}`);
	return vscode.workspace.openTextDocument(vscode.Uri.file(file));
}

function fileTabs(file: string): vscode.Tab[] {
	return vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "file" && samePath(tab.input.uri.fsPath, file));
}

function openDocuments(): format.DocumentInfo[] {
	const active = vscode.window.activeTextEditor?.document.uri.toString();
	const byUri = new Map<string, format.DocumentInfo>();
	for (const tab of vscode.window.tabGroups.all.flatMap(group => group.tabs)) {
		if (!(tab.input instanceof vscode.TabInputText)) continue;
		const key = tab.input.uri.toString();
		const known = byUri.get(key);
		if (known) known.isDirty ||= tab.isDirty;
		else byUri.set(key, { path: displayPath(tab.input.uri), isActive: key === active, isDirty: tab.isDirty, isPreview: tab.isPreview });
	}
	return [...byUri.values()];
}

function diagnosticItems(entries: ReadonlyArray<readonly [vscode.Uri, readonly vscode.Diagnostic[]]>): format.DiagnosticItem[] {
	return entries.flatMap(([uri, diagnostics]) =>
		diagnostics.map(diagnostic => ({
			severity: SEVERITY_NAMES[diagnostic.severity] ?? "error",
			code: diagnostic.code === undefined ? undefined : String(typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code),
			path: displayPath(uri),
			line: diagnostic.range.start.line + 1,
			column: diagnostic.range.start.character + 1,
			message: diagnostic.message,
			source: diagnostic.source,
		})),
	);
}

/** Where a task is defined: its folder, `user` or `workspace`. */
function scopeName(task: vscode.Task): string {
	if (typeof task.scope === "object") return task.scope.name;
	return task.scope === vscode.TaskScope.Global ? "user" : "workspace";
}

/**
 * Each task with its label, `<source>: <name>` as VS Code shows it. VS Code gives every tasks.json task the
 * source `Workspace`, so a label several tasks share is followed by where each is defined, e.g. `(frontend)`.
 */
function labelTasks(tasks: readonly vscode.Task[]): Array<{ task: vscode.Task; label: string }> {
	const base = (task: vscode.Task) => `${task.source}: ${task.name}`;
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(base(task), (counts.get(base(task)) ?? 0) + 1);
	return tasks.map(task => ({ task, label: (counts.get(base(task)) ?? 0) > 1 ? `${base(task)} (${scopeName(task)})` : base(task) }));
}

/** The task labelled `name`, else the one task whose label without its `(…)` suffix, or else whose name, is `name`; with its label. */
function findTask(tasks: readonly vscode.Task[], name: string): { task: vscode.Task; label: string } {
	const labelled = labelTasks(tasks);
	const byLabel = labelled.filter(entry => entry.label === name);
	const bySourceAndName = labelled.filter(entry => `${entry.task.source}: ${entry.task.name}` === name);
	const matches = byLabel.length > 0 ? byLabel : bySourceAndName.length > 0 ? bySourceAndName : labelled.filter(entry => entry.task.name === name);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) throw new Error(`Several tasks are named '${name}': ${matches.map(entry => entry.label).join(", ")}; pass the label.`);
	throw new Error(`No task named '${name}'. Use vscode_tasks with action list to see the tasks.`);
}

/** The entry named `name` of a list from the `launch` settings. */
function namedEntry(list: unknown, name: string): Record<string, unknown> | undefined {
	return Array.isArray(list) ? list.find((entry): entry is Record<string, unknown> => isRecord(entry) && entry.name === name) : undefined;
}

/** The records in array `key` of a DAP response body; anything else in it is ignored. */
function records(body: unknown, key: string): Array<Record<string, unknown>> {
	const list = isRecord(body) ? body[key] : undefined;
	return Array.isArray(list) ? list.filter(isRecord) : [];
}

function describeFrame(frame: Record<string, unknown>): string {
	const name = typeof frame.name === "string" ? frame.name : "?";
	const source = isRecord(frame.source) ? frame.source : {};
	const file = typeof source.path === "string" ? source.path : typeof source.name === "string" ? source.name : undefined;
	return file ? `${name} at ${file}:${String(frame.line)}` : name;
}

function parseCommandArguments(raw: string): unknown[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`'arguments' must be a JSON array: ${errorMessage(error)}`);
	}
	if (!Array.isArray(value)) throw new Error("'arguments' must be a JSON array");
	return value;
}

/**
 * The `vscode_*` tools OMP's agent calls to operate VS Code. Paths resolve against OMP's working
 * directory and must lie inside it or a workspace folder; every failure goes back as a tool error.
 */
export class VsCodeHostTools implements HostTools, vscode.Disposable {
	readonly definitions = TOOL_DEFINITIONS;
	readonly #cwd: () => string;
	readonly #debug = new DebugSessions<vscode.DebugSession>();
	readonly #subscriptions: vscode.Disposable[];
	readonly #handlers: Record<ToolName, Handler> = {
		vscode_workspace: async () => this.#workspace(),
		vscode_documents: async () => format.documents(openDocuments()),
		vscode_open_document: args => this.#openDocument(args),
		vscode_read_document: args => this.#readDocument(args),
		vscode_replace_lines: args => this.#replaceLines(args),
		vscode_save: args => this.#save(args),
		vscode_close_document: args => this.#closeDocument(args),
		vscode_selection: async () => this.#selection(),
		vscode_diagnostics: async args => this.#diagnostics(args),
		vscode_tasks: (args, signal) => this.#tasks(args, signal),
		vscode_debug: (args, signal) => this.#debugControl(args, signal),
		vscode_breakpoints: args => this.#breakpoints(args),
		vscode_debug_inspect: args => this.#inspect(args),
		vscode_find_commands: args => this.#findCommands(args),
		vscode_execute_command: args => this.#executeCommand(args),
	};

	/** `cwd`: OMP's current working directory. */
	constructor(cwd: () => string) {
		this.#cwd = cwd;
		this.#subscriptions = [
			vscode.debug.registerDebugAdapterTrackerFactory("*", {
				createDebugAdapterTracker: session => {
					this.#debug.track(session);
					return {
						onWillReceiveMessage: message => this.#debug.onClientMessage(session.id, message),
						onDidSendMessage: message => this.#debug.onMessage(session.id, message),
						onExit: () => this.#debug.onEnded(session.id),
					};
				},
			}),
			vscode.debug.onDidTerminateDebugSession(session => this.#debug.onEnded(session.id)),
		];
	}

	async invoke(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
		if (!Object.hasOwn(this.#handlers, name)) throw new Error(`Unknown tool: ${name}`);
		const cwd = this.#cwd();
		return this.#handlers[name as ToolName](new ToolArguments(args, { cwd, roots: workspaceRoots(cwd) }), signal);
	}

	dispose(): void {
		for (const subscription of this.#subscriptions) subscription.dispose();
	}

	#workspace(): string {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const active = vscode.window.activeTextEditor?.document;
		return [
			`Working directory: ${this.#cwd()}`,
			folders.length === 0 ? "Workspace folders: none" : `Workspace folders (${folders.length}):`,
			...folders.map(folder => `- ${folder.name}: ${displayPath(folder.uri)}`),
			`Active editor: ${active ? displayPath(active.uri) : "none"}`,
			"Open editors:",
			format.documents(openDocuments()),
		].join("\n");
	}

	async #openDocument(args: ToolArguments): Promise<string> {
		const file = args.requiredPath("path");
		const line = args.optionalInt("line", 1);
		const column = args.optionalInt("column", 1);
		const document = findOpenDocument(file) ?? (await openFromDisk(file));
		let selection: vscode.Range | undefined;
		if (line !== undefined) {
			if (line > document.lineCount) throw new Error(`${file} has ${document.lineCount} lines; line ${line} does not exist.`);
			const position = new vscode.Position(line - 1, Math.min((column ?? 1) - 1, document.lineAt(line - 1).text.length));
			selection = new vscode.Range(position, position);
		}
		await vscode.window.showTextDocument(document, { preview: false, selection });
		return format.opened(file, line, column);
	}

	async #readDocument(args: ToolArguments): Promise<string> {
		const file = args.requiredPath("path");
		const startLine = args.optionalInt("startLine", 1);
		const endLine = args.optionalInt("endLine", 1);
		if (startLine !== undefined && endLine !== undefined && endLine < startLine) throw new Error("'endLine' must not be before 'startLine'");
		const open = findOpenDocument(file);
		if (open) {
			return format.documentListing({ path: file, totalLines: open.lineCount, lineAt: line => open.lineAt(line).text, fromEditor: true }, startLine, endLine);
		}
		if (!(await exists(file))) throw new Error(`File not found: ${file}`);
		const lines = splitLines(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file))));
		return format.documentListing({ path: file, totalLines: lines.length, lineAt: line => lines[line], fromEditor: false }, startLine, endLine);
	}

	async #replaceLines(args: ToolArguments): Promise<string> {
		const file = args.requiredPath("path");
		const startLine = args.requiredInt("startLine", 1);
		const endLine = args.requiredInt("endLine", 0);
		const text = args.requiredString("text", true);
		if (endLine < startLine - 1) throw new Error("'endLine' must be at least startLine - 1");
		const document = findOpenDocument(file) ?? (await openFromDisk(file));
		await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true });
		const lineBreak = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
		const plan = planLineEdit(document.lineCount, line => document.lineAt(line).text.length, startLine, endLine, text, lineBreak);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(plan.startLine, plan.startCharacter, plan.endLine, plan.endCharacter), plan.text);
		if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected the edit of ${file}; the document may be read-only.`);
		return format.replaced(file, startLine, endLine);
	}

	async #save(args: ToolArguments): Promise<string> {
		const file = args.optionalPath("path");
		if (file !== undefined) {
			const document = findOpenDocument(file);
			if (!document) throw new Error(`${file} is not open in the editor.`);
			if (!document.isDirty) return format.saved([]);
			if (!(await document.save())) throw new Error(`VS Code could not save ${file}.`);
			return format.saved([file]);
		}
		const saved: string[] = [];
		const failures: string[] = [];
		for (const document of vscode.workspace.textDocuments.filter(candidate => candidate.isDirty && !candidate.isUntitled)) {
			if (await document.save()) saved.push(displayPath(document.uri));
			else failures.push(`VS Code could not save ${displayPath(document.uri)}.`);
		}
		if (failures.length > 0) throw new Error(`${failures.join(" ")} Saved: ${saved.length === 0 ? "none" : saved.join(", ")}.`);
		return format.saved(saved);
	}

	async #closeDocument(args: ToolArguments): Promise<string> {
		const file = args.requiredPath("path");
		const save = args.optionalBool("save") ?? false;
		const document = findOpenDocument(file);
		if (!document && fileTabs(file).length === 0) throw new Error(`${file} is not open in the editor.`);
		if (document?.isDirty) {
			if (save) {
				if (!(await document.save())) throw new Error(`VS Code could not save ${file}.`);
			} else {
				const editor = await vscode.window.showTextDocument(document, { preview: false });
				if (editor.document !== document || vscode.window.activeTextEditor?.document !== document) {
					throw new Error(`VS Code could not activate ${file} to discard its unsaved changes.`);
				}
				await vscode.commands.executeCommand("workbench.action.files.revert");
				if (document.isDirty) throw new Error(`VS Code could not discard the unsaved changes of ${file}.`);
			}
		}
		const tabs = fileTabs(file);
		if (tabs.length > 0 && !(await vscode.window.tabGroups.close(tabs))) throw new Error(`VS Code did not close ${file}.`);
		return save ? `Saved and closed ${file}.` : `Closed ${file}.`;
	}

	#selection(): string {
		const editor = vscode.window.activeTextEditor;
		if (!editor) return format.selection(undefined);
		const { start, end } = editor.selection;
		return format.selection({
			path: displayPath(editor.document.uri),
			startLine: start.line + 1,
			startColumn: start.character + 1,
			endLine: end.line + 1,
			endColumn: end.character + 1,
			text: editor.document.getText(editor.selection),
		});
	}

	#diagnostics(args: ToolArguments): string {
		const severity = args.optionalChoice("severity", SEVERITIES, "error");
		const file = args.optionalPath("path");
		const max = args.optionalInt("max", 1) ?? DEFAULT_DIAGNOSTICS;
		const uri = file === undefined ? undefined : vscode.Uri.file(file);
		const entries = uri ? [[uri, vscode.languages.getDiagnostics(uri)] as const] : vscode.languages.getDiagnostics();
		return format.diagnostics(diagnosticItems(entries), severity, max);
	}

	async #tasks(args: ToolArguments, signal: AbortSignal): Promise<string> {
		const action = args.optionalChoice("action", TASK_ACTIONS, "list");
		const name = action === "run" ? args.requiredString("name") : undefined;
		const tasks = await vscode.tasks.fetchTasks();
		if (name === undefined) {
			return format.tasks(labelTasks(tasks).map(({ task, label }) => ({ label, group: task.group?.id, isBackground: task.isBackground })));
		}
		const { task, label } = findTask(tasks, name);
		signal.throwIfAborted();
		if (task.isBackground) {
			await vscode.tasks.executeTask(task);
			return `Started background task ${label}; it keeps running.`;
		}
		const exitCodes = new Map<vscode.TaskExecution, number | undefined>();
		const ended = new Set<vscode.TaskExecution>();
		let check = () => {};
		const onAbort = () => check();
		const subscriptions = [
			vscode.tasks.onDidEndTaskProcess(event => {
				exitCodes.set(event.execution, event.exitCode);
				check();
			}),
			vscode.tasks.onDidEndTask(event => {
				ended.add(event.execution);
				check();
			}),
		];
		try {
			const execution = await vscode.tasks.executeTask(task);
			await new Promise<void>((resolve, reject) => {
				check = () => {
					const done = exitCodes.has(execution) || ended.has(execution);
					if (signal.aborted) {
						check = () => {};
						if (!done) execution.terminate();
						reject(signal.reason);
					} else if (done) resolve();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				check();
			});
			return format.taskResult(label, exitCodes.get(execution), diagnosticItems(vscode.languages.getDiagnostics()));
		} finally {
			signal.removeEventListener("abort", onAbort);
			for (const subscription of subscriptions) subscription.dispose();
		}
	}

	async #debugControl(args: ToolArguments, signal: AbortSignal): Promise<string> {
		const action = args.requiredChoice("action", DEBUG_ACTIONS);
		switch (action) {
			case "state":
				return this.#debuggerState();
			case "start":
				return this.#startDebugging(args.optionalString("configuration"), args.optionalBool("noDebug") ?? false, signal);
			case "stop": {
				const active = vscode.debug.activeDebugSession;
				if (!active) return this.#debuggerState();
				const ended = await this.#debug.endAfter(() => vscode.debug.stopDebugging(), STOP_WAIT_MS, signal, [active.id]);
				return ended ? "Debugger: not running." : this.#debuggerState();
			}
			case "pause": {
				const session = vscode.debug.activeDebugSession;
				if (!session) throw new Error("No debug session is running. Use vscode_debug with action start first.");
				if (this.#stoppedTarget()) return this.#debuggerState();
				const outcome = await this.#debug.waitAfter(
					() => vscode.commands.executeCommand("workbench.action.debug.pause"),
					PAUSE_WAIT_MS,
					signal,
					session.id,
				);
				return this.#describeOutcome(outcome, PAUSE_WAIT_MS);
			}
			default:
				return this.#resume(action, signal);
		}
	}

	async #startDebugging(configuration: string | undefined, noDebug: boolean, signal: AbortSignal): Promise<string> {
		const active = vscode.debug.activeDebugSession;
		if (active) throw new Error(`The debugger is already running (${active.name}); stop it first.`);
		const outcome = await this.#debug.waitAfter(
			async () => {
				if (configuration === undefined) {
					await vscode.commands.executeCommand(noDebug ? "workbench.action.debug.run" : "workbench.action.debug.start");
				} else {
					const target = this.#launchTarget(configuration);
					if (!(await vscode.debug.startDebugging(target.folder, target.configuration, { noDebug }))) {
						throw new Error(`VS Code could not start the launch configuration '${configuration}'.`);
					}
				}
			},
			START_GRACE_MS,
			signal,
		);
		return this.#describeOutcome(outcome, START_GRACE_MS);
	}

	/**
	 * How to start launch configuration `name`. VS Code looks a name up only in the launch.json of the folder it
	 * is given, so one from the workspace file or user settings starts as its configuration, without a folder,
	 * as VS Code starts those itself. A name nothing defines goes to the first folder, and VS Code reports it.
	 */
	#launchTarget(name: string): { folder: vscode.WorkspaceFolder | undefined; configuration: string | vscode.DebugConfiguration } {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const folder = folders.find(candidate => {
			const launch = vscode.workspace.getConfiguration("launch", candidate.uri);
			return namedEntry(launch.inspect("configurations")?.workspaceFolderValue, name) ?? namedEntry(launch.inspect("compounds")?.workspaceFolderValue, name);
		});
		if (folder) return { folder, configuration: name };
		const launch = vscode.workspace.getConfiguration("launch");
		const levels = [
			["workspaceValue", "workspace file"],
			["globalValue", "user settings"],
		] as const;
		for (const [level, where] of levels) {
			const configuration = namedEntry(launch.inspect("configurations")?.[level], name);
			if (configuration) {
				const overrides = configuration[PLATFORM_KEY];
				return { folder: undefined, configuration: { ...configuration, ...(isRecord(overrides) ? overrides : {}) } as vscode.DebugConfiguration };
			}
			if (namedEntry(launch.inspect("compounds")?.[level], name)) {
				throw new Error(
					`'${name}' is a compound launch configuration in the ${where}; VS Code lets extensions start compounds only from a folder's launch.json. Start it from the Run and Debug view.`,
				);
			}
		}
		return { folder: folders[0], configuration: name };
	}

	async #resume(action: ResumeAction, signal: AbortSignal): Promise<string> {
		const target = this.#stoppedTarget();
		if (!target) {
			throw new Error(
				vscode.debug.activeDebugSession
					? "The debuggee is not stopped (it is running). Use vscode_debug with action pause first."
					: "No debug session is running. Use vscode_debug with action start first.",
			);
		}
		const threadId = await this.#threadId(target.session, target.stop);
		// The workbench commands find the thread by VS Code's debug model id for it.
		const context = { sessionId: target.session.id, threadId: `thread:${target.session.id}:${threadId}` };
		const outcome = await this.#debug.waitAfter(
			() => vscode.commands.executeCommand(RESUME_COMMANDS[action], undefined, context),
			RESUME_WAIT_MS,
			signal,
			target.session.id,
		);
		return this.#describeOutcome(outcome, RESUME_WAIT_MS);
	}

	/** The stopped session the user sees (the active one), else the first stopped one. */
	#stoppedTarget(): { session: vscode.DebugSession; stop: DebugStop } | undefined {
		const stopped = this.#debug.stopped();
		const active = vscode.debug.activeDebugSession;
		return stopped.find(entry => entry.session.id === active?.id) ?? stopped[0];
	}

	async #debuggerState(): Promise<string> {
		const target = this.#stoppedTarget();
		if (target) return this.#describeStop(target.session, target.stop);
		const active = vscode.debug.activeDebugSession;
		return active ? `Debugger: running (${active.name}).` : "Debugger: not running.";
	}

	async #describeOutcome(outcome: DebugOutcome<vscode.DebugSession>, waitedMs: number): Promise<string> {
		if (outcome.kind === "stopped") return this.#describeStop(outcome.session, outcome.stop);
		if (outcome.kind === "ended") return "Debugger: not running (the debug session ended).";
		const active = vscode.debug.activeDebugSession;
		return active ? `Debugger: running (${active.name}); it did not stop within ${waitedMs / 1000} s.` : "Debugger: not running.";
	}

	async #describeStop(session: vscode.DebugSession, stop: DebugStop): Promise<string> {
		let location: string;
		try {
			const [top] = await this.#frames(session, stop, 1);
			location = top ? describeFrame(top) : "no stack frames";
		} catch (error) {
			location = `unavailable (${errorMessage(error)})`;
		}
		return format.stoppedDebugger({
			session: session.name,
			reason: stop.reason,
			location,
			exception: stop.reason === "exception" ? stop.text : undefined,
		});
	}

	async #threadId(session: vscode.DebugSession, stop: DebugStop): Promise<number> {
		if (stop.threadId !== undefined) return stop.threadId;
		const [thread] = records(await session.customRequest("threads"), "threads");
		if (typeof thread?.id !== "number") throw new Error(`The debug session ${session.name} reports no threads.`);
		return thread.id;
	}

	async #frames(session: vscode.DebugSession, stop: DebugStop, levels: number): Promise<Array<Record<string, unknown>>> {
		const threadId = await this.#threadId(session, stop);
		return records(await session.customRequest("stackTrace", { threadId, startFrame: 0, levels }), "stackFrames");
	}

	async #breakpoints(args: ToolArguments): Promise<string> {
		const action = args.requiredChoice("action", BREAKPOINT_ACTIONS);
		if (action === "list") {
			return format.breakpoints(
				vscode.debug.breakpoints.flatMap(breakpoint => {
					const { condition, enabled } = breakpoint;
					if (breakpoint instanceof vscode.SourceBreakpoint) {
						const { uri, range } = breakpoint.location;
						return [{ location: `${displayPath(uri)}:${range.start.line + 1}`, condition, enabled }];
					}
					if (breakpoint instanceof vscode.FunctionBreakpoint) return [{ location: `function ${breakpoint.functionName}`, condition, enabled }];
					return [];
				}),
			);
		}
		const file = args.requiredPath("path");
		if (action === "add") {
			const line = args.requiredInt("line", 1);
			const condition = args.optionalString("condition");
			if (!(await exists(file))) throw new Error(`File not found: ${file}`);
			const location = new vscode.Location(vscode.Uri.file(file), new vscode.Position(line - 1, 0));
			vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true, condition)]);
			return `Breakpoint set at ${file}:${line}.`;
		}
		const line = args.optionalInt("line", 1);
		const matching = vscode.debug.breakpoints.filter(
			breakpoint =>
				breakpoint instanceof vscode.SourceBreakpoint &&
				breakpoint.location.uri.scheme === "file" &&
				samePath(breakpoint.location.uri.fsPath, file) &&
				(line === undefined || breakpoint.location.range.start.line === line - 1),
		);
		if (matching.length > 0) vscode.debug.removeBreakpoints(matching);
		return format.breakpointsRemoved(matching.length, file, line);
	}

	async #inspect(args: ToolArguments): Promise<string> {
		const kind = args.requiredChoice("kind", INSPECT_KINDS);
		const expression = kind === "evaluate" ? args.requiredString("expression") : undefined;
		const target = this.#stoppedTarget();
		if (!target) throw new Error("The debuggee is not stopped. Use vscode_debug to pause it or to run to a breakpoint first.");
		const { session, stop } = target;
		const frames = await this.#frames(session, stop, kind === "callstack" ? MAX_STACK_FRAMES : 1);
		if (kind === "callstack") return format.callStack(frames.map(describeFrame));
		const frameId = frames[0]?.id;
		if (typeof frameId !== "number") throw new Error("The stopped thread has no stack frames.");
		if (expression !== undefined) {
			const response: unknown = await session.customRequest("evaluate", { expression, frameId, context: "repl" });
			const result = isRecord(response) && typeof response.result === "string" ? response.result : "";
			return result.length === 0 ? "(empty result)" : result;
		}
		const variables: format.VariableInfo[] = [];
		const scopes = records(await session.customRequest("scopes", { frameId }), "scopes");
		for (const scope of scopes) {
			if (variables.length >= MAX_LOCALS) break;
			if (scope.expensive === true || typeof scope.variablesReference !== "number" || scope.variablesReference <= 0) continue;
			for (const variable of records(await session.customRequest("variables", { variablesReference: scope.variablesReference }), "variables")) {
				if (variables.length >= MAX_LOCALS) break;
				variables.push({
					name: String(variable.name),
					type: typeof variable.type === "string" && variable.type ? variable.type : undefined,
					value: String(variable.value ?? ""),
				});
			}
		}
		return format.locals(variables);
	}

	async #findCommands(args: ToolArguments): Promise<string> {
		const filter = args.requiredString("filter");
		const max = args.optionalInt("max", 1) ?? DEFAULT_COMMANDS;
		const needle = filter.toLowerCase();
		const matches = (await vscode.commands.getCommands(true))
			.map(id => ({ id, key: id.toLowerCase() }))
			.filter(command => command.key.includes(needle))
			.sort(
				(a, b) =>
					Number(!a.key.startsWith(needle)) - Number(!b.key.startsWith(needle)) ||
					a.id.length - b.id.length ||
					(a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
			)
			.slice(0, max)
			.map(command => command.id);
		return matches.length === 0 ? `No commands match '${filter}'.` : matches.join("\n");
	}

	async #executeCommand(args: ToolArguments): Promise<string> {
		const command = args.requiredString("command");
		const raw = args.optionalString("arguments");
		const commandArgs = raw === undefined ? [] : parseCommandArguments(raw);
		let result: unknown;
		try {
			result = await vscode.commands.executeCommand(command, ...commandArgs);
		} catch (error) {
			if (errorMessage(error) === `command '${command}' not found`) {
				throw new Error(`Unknown command '${command}'. Use vscode_find_commands to look up command ids.`);
			}
			throw error;
		}
		const executed = raw === undefined ? `Executed ${command}.` : `Executed ${command} with arguments ${raw}.`;
		if (result === undefined) return executed;
		let json: string | undefined;
		try {
			json = JSON.stringify(result, null, 2);
		} catch (error) {
			return `${executed} Its result is not JSON: ${errorMessage(error)}`;
		}
		return json === undefined ? `${executed} Its result (${typeof result}) is not JSON.` : `${executed} Result:\n${json}`;
	}
}
