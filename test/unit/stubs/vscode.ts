/**
 * The `vscode` module as seen by unit tests (the unit test build aliases `vscode` here).
 *
 * Every API function records its call in `stub.calls` and returns what the test
 * registered with `stub.on(api, handler)`, otherwise `undefined` (wrapped in a
 * promise where VS Code returns a Thenable). Configuration values come from
 * `stub.config`. Value types (`Uri`, `EventEmitter`, `TreeItem`, …) behave like
 * their VS Code counterparts for the members implemented here. Call
 * `stub.reset()` in `beforeEach`.
 */

export interface StubCall {
	api: string;
	args: unknown[];
}

type Handler = (...args: never[]) => unknown;

export const stub = {
	calls: [] as StubCall[],
	handlers: new Map<string, Handler>(),
	/** `"<section>.<key>"` → value returned by `workspace.getConfiguration(section).get(key)`. */
	config: new Map<string, unknown>(),
	/** Answer calls to `api` (e.g. `"window.showQuickPick"`) with `handler(...args)`. */
	on(api: string, handler: Handler): void {
		this.handlers.set(api, handler);
	},
	callsTo(api: string): unknown[][] {
		return this.calls.filter(call => call.api === api).map(call => call.args);
	},
	reset(): void {
		this.calls.length = 0;
		this.handlers.clear();
		this.config.clear();
		window.activeTextEditor = undefined;
		tabGroups.all = [];
		workspace.workspaceFolders = undefined;
		workspace.isTrusted = true;
		trustGranted.dispose();
	},
	/** Fires `workspace.onDidGrantWorkspaceTrust`. */
	grantTrust(): void {
		trustGranted.fire();
	},
};

function record(api: string, args: unknown[]): unknown {
	stub.calls.push({ api, args });
	const handler = stub.handlers.get(api) as ((...values: unknown[]) => unknown) | undefined;
	return handler ? handler(...args) : undefined;
}

const recorded =
	(api: string) =>
	(...args: unknown[]): unknown =>
		record(api, args);

const thenable =
	(api: string) =>
	(...args: unknown[]): Promise<unknown> =>
		Promise.resolve(record(api, args));

export class Disposable {
	static from(...disposables: Array<{ dispose(): unknown }>): Disposable {
		return new Disposable(() => {
			for (const disposable of disposables) disposable.dispose();
		});
	}

	constructor(private readonly callOnDispose: () => unknown) {}

	dispose(): void {
		this.callOnDispose();
	}
}

export class EventEmitter<T> {
	private listeners: Array<(value: T) => unknown> = [];

	readonly event = (listener: (value: T) => unknown): Disposable => {
		this.listeners.push(listener);
		return new Disposable(() => {
			this.listeners = this.listeners.filter(candidate => candidate !== listener);
		});
	};

	fire(value: T): void {
		for (const listener of [...this.listeners]) listener(value);
	}

	dispose(): void {
		this.listeners = [];
	}
}

const trustGranted = new EventEmitter<void>();

export class CancellationTokenSource {
	private readonly cancelled = new EventEmitter<void>();
	readonly token = {
		isCancellationRequested: false,
		onCancellationRequested: this.cancelled.event,
	};

	cancel(): void {
		if (this.token.isCancellationRequested) return;
		this.token.isCancellationRequested = true;
		this.cancelled.fire();
	}

	dispose(): void {
		this.cancelled.dispose();
	}
}

/** Mirrors `vscode-uri`: `path` uses `/`, `fsPath` is the platform path of a `file` URI. */
export class Uri {
	private constructor(
		readonly scheme: string,
		readonly authority: string,
		readonly path: string,
		readonly query: string,
		readonly fragment: string,
	) {}

	static file(fsPath: string): Uri {
		const slashed = process.platform === "win32" ? fsPath.replace(/\\/g, "/") : fsPath;
		return new Uri("file", "", slashed.startsWith("/") ? slashed : `/${slashed}`, "", "");
	}

	static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
		return new Uri(components.scheme, components.authority ?? "", components.path ?? "", components.query ?? "", components.fragment ?? "");
	}

	static parse(value: string): Uri {
		const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
		if (!match) throw new Error(`Invalid URI: ${value}`);
		return new Uri(match[1], match[2] ?? "", match[3], match[4] ?? "", match[5] ?? "");
	}

	static joinPath(base: Uri, ...segments: string[]): Uri {
		const joined = [base.path, ...segments].join("/").replace(/\/+/g, "/");
		return base.with({ path: joined });
	}

	get fsPath(): string {
		const value =
			this.authority && this.scheme === "file"
				? `//${this.authority}${this.path}`
				: /^\/[a-zA-Z]:/.test(this.path)
					? `${this.path[1].toLowerCase()}${this.path.slice(2)}`
					: this.path;
		return process.platform === "win32" ? value.replace(/\//g, "\\") : value;
	}

	with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
		return new Uri(
			change.scheme ?? this.scheme,
			change.authority ?? this.authority,
			change.path ?? this.path,
			change.query ?? this.query,
			change.fragment ?? this.fragment,
		);
	}

	toString(): string {
		const authority = this.authority || this.scheme === "file" ? `//${this.authority}` : "";
		return `${this.scheme}:${authority}${this.path}${this.query ? `?${this.query}` : ""}${this.fragment ? `#${this.fragment}` : ""}`;
	}
}

export class ThemeColor {
	constructor(readonly id: string) {}
}

export class ThemeIcon {
	static readonly File = new ThemeIcon("file");
	static readonly Folder = new ThemeIcon("folder");

	constructor(
		readonly id: string,
		readonly color?: ThemeColor,
	) {}
}

/** Unlike VS Code, `appendText` does not escape Markdown: `value` is the plain concatenation of everything appended. */
export class MarkdownString {
	isTrusted?: boolean;
	supportThemeIcons?: boolean;

	constructor(public value = "") {}

	appendText(text: string): this {
		this.value += text;
		return this;
	}

	appendMarkdown(markdown: string): this {
		this.value += markdown;
		return this;
	}
}

export enum TreeItemCollapsibleState {
	None = 0,
	Collapsed = 1,
	Expanded = 2,
}

export class TreeItem {
	id?: string;
	description?: string | boolean;
	tooltip?: string | MarkdownString;
	iconPath?: ThemeIcon | Uri;
	resourceUri?: Uri;
	contextValue?: string;
	command?: { command: string; title: string; arguments?: unknown[] };

	constructor(
		public label: string | { label: string },
		public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
	) {}
}

export enum ExtensionMode {
	Production = 1,
	Development = 2,
	Test = 3,
}

export enum StatusBarAlignment {
	Left = 1,
	Right = 2,
}

export enum QuickPickItemKind {
	Separator = -1,
	Default = 0,
}

export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3,
}

export class TabInputText {
	constructor(readonly uri: Uri) {}
}

export class TabInputTextDiff {
	constructor(
		readonly original: Uri,
		readonly modified: Uri,
	) {}
}

export class Position {
	constructor(
		readonly line: number,
		readonly character: number,
	) {}
}

export class Range {
	constructor(
		readonly start: Position,
		readonly end: Position,
	) {}
}

/** Like VS Code: `code` names the failure, e.g. `FileNotFound`. */
export class FileSystemError extends Error {
	static FileNotFound(target?: string | Uri): FileSystemError {
		return new FileSystemError(`${target ?? ""} not found`, "FileNotFound");
	}

	constructor(
		message: string,
		readonly code = "Unknown",
	) {
		super(message);
	}
}

/** Status bar item whose `show`/`hide`/`dispose` calls are recorded as `statusBarItem.<method>`. */
function createStatusBarItem(...args: unknown[]) {
	record("window.createStatusBarItem", args);
	const item = {
		text: "",
		tooltip: undefined as unknown,
		command: undefined as unknown,
		name: undefined as string | undefined,
		show: () => record("statusBarItem.show", [item]),
		hide: () => record("statusBarItem.hide", [item]),
		dispose: () => record("statusBarItem.dispose", [item]),
	};
	return item;
}

const tabGroups = { all: [] as unknown[], close: thenable("window.tabGroups.close") };

export enum ProgressLocation {
	SourceControl = 1,
	Window = 10,
	Notification = 15,
}

/** Records the call and runs `task` with a no-op progress and a fresh token. */
function withProgress(options: unknown, task: (progress: { report(value: unknown): void }, token: CancellationTokenSource["token"]) => unknown): unknown {
	record("window.withProgress", [options, task]);
	return task({ report() {} }, new CancellationTokenSource().token);
}

export const window = {
	activeTextEditor: undefined as unknown,
	tabGroups,
	showInformationMessage: thenable("window.showInformationMessage"),
	showWarningMessage: thenable("window.showWarningMessage"),
	showErrorMessage: thenable("window.showErrorMessage"),
	showQuickPick: thenable("window.showQuickPick"),
	showInputBox: thenable("window.showInputBox"),
	showTextDocument: thenable("window.showTextDocument"),
	createStatusBarItem,
	withProgress,
};

export const commands = {
	executeCommand: thenable("commands.executeCommand"),
	/** Without a handler: no commands. */
	getCommands: (...args: unknown[]): Promise<unknown> => Promise.resolve(record("commands.getCommands", args) ?? []),
	registerCommand: (...args: unknown[]): Disposable => {
		record("commands.registerCommand", args);
		return new Disposable(() => record("commands.registerCommand.dispose", args));
	},
};

export const workspace = {
	workspaceFolders: undefined as unknown,
	isTrusted: true,
	onDidGrantWorkspaceTrust: (listener: () => unknown): Disposable => trustGranted.event(listener),
	getConfiguration(section?: string) {
		record("workspace.getConfiguration", [section]);
		const key = (name: string) => (section ? `${section}.${name}` : name);
		return {
			get: <T>(name: string, defaultValue?: T): T | undefined => (stub.config.has(key(name)) ? (stub.config.get(key(name)) as T) : defaultValue),
			has: (name: string): boolean => stub.config.has(key(name)),
			update: thenable("workspaceConfiguration.update"),
		};
	},
	asRelativePath: recorded("workspace.asRelativePath"),
	getWorkspaceFolder: recorded("workspace.getWorkspaceFolder"),
	openTextDocument: thenable("workspace.openTextDocument"),
	/** Without a handler: an empty result. */
	findFiles: (...args: unknown[]): Promise<unknown> => Promise.resolve(record("workspace.findFiles", args) ?? []),
	/** Without a handler `stat` resolves, i.e. every file exists. */
	fs: { stat: thenable("workspace.fs.stat") },
};

export const languages = {
	/** Without a handler: no diagnostics. */
	getDiagnostics: (...args: unknown[]): unknown => record("languages.getDiagnostics", args) ?? [],
};

export const extensions = {
	getExtension: recorded("extensions.getExtension"),
};

export const env = {
	openExternal: thenable("env.openExternal"),
};

export const debug = {
	registerDebugAdapterTrackerFactory: (...args: unknown[]): Disposable => {
		record("debug.registerDebugAdapterTrackerFactory", args);
		return new Disposable(() => record("debug.registerDebugAdapterTrackerFactory.dispose", args));
	},
	onDidTerminateDebugSession: (...args: unknown[]): Disposable => {
		record("debug.onDidTerminateDebugSession", args);
		return new Disposable(() => undefined);
	},
};
