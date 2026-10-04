import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Disposable, Logger, OmpServiceApi, ToolExecutionEvent, TranscriptItem } from "../omp/api";
import { changeRowDescription, changesSummary } from "../ui/treeRows";
import { errorMessage } from "../ui/guards";
import { BASELINE_SCHEME, BaselineContentProvider, baselineUri, EMPTY_QUERY } from "./BaselineContentProvider";
import { lineDelta, resolveToolPath, toolArgPaths, toolResultFiles } from "./changePaths";

export interface TrackedChange {
	/** Absolute filesystem path. */
	path: string;
	status: "A" | "M" | "D";
	added: number;
	removed: number;
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ast_grep", "find", "lsp", "debug", "fetch", "web_search"]);
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/**
 * Snapshots files before OMP tools touch them and lists what changed since, so the
 * native diff editor can compare the first-seen baseline with the current file.
 */
export class ChangeTracker implements vscode.TreeDataProvider<TrackedChange>, vscode.Disposable {
	/** Baseline content per absolute path; `null` = file did not exist. */
	private readonly baselines = new Map<string, string | null>();
	/**
	 * Tool call whose start snapshot set each baseline. A start event can arrive after OMP
	 * already wrote the file, so that call's own reported `oldText` replaces its snapshot.
	 */
	private readonly baselineSource = new Map<string, string>();
	private readonly byPath = new Map<string, TrackedChange>();
	private queue: Promise<void> = Promise.resolve();
	private subscriptions: Disposable[] = [];
	private service: OmpServiceApi | undefined;
	private sessionId: string | undefined;
	private readonly treeEmitter = new vscode.EventEmitter<void>();
	private readonly baselineEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly summaryEmitter = new vscode.EventEmitter<string>();
	private lastSummary = "";

	readonly onDidChangeTreeData = this.treeEmitter.event;
	/** Fires with the new {@link summary} when it changes. */
	readonly onDidChangeSummary = this.summaryEmitter.event;
	/** Fires with the `omp-base:` uri whose content changed. */
	readonly onDidChangeBaseline = this.baselineEmitter.event;
	/** Serves `omp-base:` documents for the diff editor. */
	readonly contentProvider = new BaselineContentProvider(filePath => this.baseline(filePath), this.onDidChangeBaseline);

	constructor(private readonly logger: Logger) {
		this.treeEmitter.event(() => {
			const summary = changesSummary(this.byPath.size);
			if (summary === this.lastSummary) return;
			this.lastSummary = summary;
			this.summaryEmitter.fire(summary);
		});
	}

	/** View description, e.g. `3 files`; empty without changes. */
	summary(): string {
		return this.lastSummary;
	}

	get changes(): readonly TrackedChange[] {
		return [...this.byPath.values()];
	}

	setService(service: OmpServiceApi | undefined): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.service = service;
		this.sessionId = service?.session.sessionId;
		this.subscriptions = service
			? [
					service.onToolExecution(event => {
						this.queue = this.queue.then(() => this.handle(event)).catch(error => this.logger.error("Change tracking failed", error));
					}),
					service.onDidChangeSession(session => {
						if (session.sessionId === this.sessionId) return;
						const hadSession = this.sessionId !== undefined;
						this.sessionId = session.sessionId;
						if (hadSession) this.clear();
					}),
				]
			: [];
	}

	/** Resolves once every tool event received so far has been processed. */
	whenIdle(): Promise<void> {
		return this.queue;
	}

	baseline(filePath: string): string | undefined {
		return this.baselines.get(filePath) ?? undefined;
	}

	/** Forgets all changes and closes their diff editors, whose baselines would otherwise render as empty. */
	clear(): void {
		const staleDiffs = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === BASELINE_SCHEME);
		if (staleDiffs.length > 0) {
			vscode.window.tabGroups.close(staleDiffs).then(undefined, error => this.logger.error("Closing OMP change diffs failed", error));
		}
		const paths = [...this.baselines.keys()];
		this.baselines.clear();
		this.baselineSource.clear();
		this.byPath.clear();
		this.treeEmitter.fire();
		for (const filePath of paths) this.baselineEmitter.fire(baselineUri(filePath));
	}

	async openDiff(target: TrackedChange | vscode.Uri): Promise<void> {
		const filePath = target instanceof vscode.Uri ? target.fsPath : target.path;
		const change = this.byPath.get(filePath);
		const right = change?.status === "D" ? baselineUri(filePath, EMPTY_QUERY) : vscode.Uri.file(filePath);
		const left = this.baselines.has(filePath) ? baselineUri(filePath) : baselineUri(filePath, EMPTY_QUERY);
		await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(filePath)} (OMP changes)`);
	}

	/**
	 * Native diff for one tool call: the tracked change when the file is tracked, else the
	 * tool's own `oldText` snapshot against the current file. Returns false when neither exists.
	 */
	async openToolDiff(item: Extract<TranscriptItem, { kind: "tool" }>): Promise<boolean> {
		const cwd = this.service?.cwd;
		if (!cwd) return false;
		const files = toolResultFiles(item.result?.details);
		const candidates = [...files.map(file => file.path), ...toolArgPaths(item.args)]
			.map(raw => resolveToolPath(raw, cwd))
			.filter((p): p is string => p !== undefined);
		const tracked = candidates.find(filePath => this.byPath.has(filePath));
		if (tracked) {
			await this.openDiff(vscode.Uri.file(tracked));
			return true;
		}
		const withOld = files.find(file => file.oldText !== undefined);
		if (!withOld?.oldText) return false;
		const filePath = resolveToolPath(withOld.path, cwd);
		if (!filePath) return false;
		const left = this.contentProvider.pin(filePath, withOld.oldText);
		await vscode.commands.executeCommand("vscode.diff", left, vscode.Uri.file(filePath), `${path.basename(filePath)} (OMP ${item.name})`);
		return true;
	}

	private async readDisk(filePath: string): Promise<string | null | undefined> {
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return undefined;
			return await fs.readFile(filePath, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			this.logger.warn(`Cannot snapshot ${filePath}: ${errorMessage(error)}`);
			return undefined;
		}
	}

	private async handle(event: ToolExecutionEvent): Promise<void> {
		const cwd = this.service?.cwd;
		if (!cwd || READ_ONLY_TOOLS.has(event.name)) return;
		const argPaths = toolArgPaths(event.args)
			.map(raw => resolveToolPath(raw, cwd))
			.filter((p): p is string => p !== undefined);
		if (event.phase === "start") {
			for (const filePath of argPaths) {
				if (this.baselines.has(filePath)) continue;
				const content = await this.readDisk(filePath);
				if (content === undefined) continue;
				this.baselines.set(filePath, content);
				this.baselineSource.set(filePath, event.toolCallId);
			}
			return;
		}
		const reported = new Map<string, string | null>();
		for (const file of toolResultFiles(event.result?.details)) {
			const resolved = resolveToolPath(file.path, cwd);
			if (resolved && !reported.has(resolved)) reported.set(resolved, file.oldText ?? null);
		}
		for (const [filePath, oldText] of reported) {
			if (typeof oldText !== "string" || this.baselineSource.get(filePath) !== event.toolCallId) continue;
			this.baselines.set(filePath, oldText);
			this.baselineEmitter.fire(baselineUri(filePath));
		}
		const candidates = new Set([...argPaths.filter(p => this.baselines.has(p)), ...reported.keys()]);
		let changed = false;
		for (const filePath of candidates) {
			const current = await this.readDisk(filePath);
			if (current === undefined) continue;
			if (!this.baselines.has(filePath)) {
				this.baselines.set(filePath, reported.get(filePath) ?? null);
				this.baselineEmitter.fire(baselineUri(filePath));
			}
			const before = this.baselines.get(filePath) ?? null;
			if (before === current) {
				changed = this.byPath.delete(filePath) || changed;
				continue;
			}
			const status = before === null ? "A" : current === null ? "D" : "M";
			this.byPath.set(filePath, { path: filePath, status, ...lineDelta(before, current) });
			changed = true;
		}
		if (changed) this.treeEmitter.fire();
	}

	getTreeItem(change: TrackedChange): vscode.TreeItem {
		const item = new vscode.TreeItem(path.basename(change.path));
		item.id = change.path;
		item.description = changeRowDescription(change, this.service?.cwd);
		const counts = change.status === "D" ? "" : ` +${change.added} −${change.removed}`;
		item.tooltip = `${change.path}\n${{ A: "added", M: "modified", D: "deleted" }[change.status]}${counts}`;
		item.resourceUri = vscode.Uri.file(change.path);
		item.contextValue = "change";
		item.command = { command: "omp.changes.openDiff", title: "Open Diff", arguments: [change] };
		return item;
	}

	getChildren(element?: TrackedChange): TrackedChange[] {
		if (element) return [];
		return this.changes.slice().sort((a, b) => a.path.localeCompare(b.path));
	}

	dispose(): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.treeEmitter.dispose();
		this.baselineEmitter.dispose();
		this.summaryEmitter.dispose();
	}
}
