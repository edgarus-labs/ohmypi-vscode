import * as path from "node:path";
import * as vscode from "vscode";
import type { Disposable, Logger, OmpServiceApi, ToolExecutionEvent, TranscriptItem } from "../omp/api";
import { toolArgPaths, toolResultFiles } from "../shared/toolFiles";
import { BASELINE_SCHEME, BaselineContentProvider, baselineUri, EMPTY_QUERY } from "./BaselineContentProvider";
import { ChangeModel, type ChangeScope, type ReadSnapshot, readSnapshot, type TrackedChange } from "./changeModel";
import { resolveToolPath } from "./changePaths";
import { changeRowDescription, changesSummary } from "./changeRows";
import { confirmToolFile, workspaceRoots } from "./workspaceFiles";

/**
 * Snapshots files before OMP tools touch them and lists what changed since, so the
 * native diff editor can compare the first-seen baseline with the current file.
 */
export class ChangeTracker implements vscode.TreeDataProvider<TrackedChange>, vscode.Disposable {
	private readonly model: ChangeModel;
	private queue: Promise<void> = Promise.resolve();
	private subscriptions: Disposable[] = [];
	private service: OmpServiceApi | undefined;
	private sessionId: string | undefined;
	private readonly treeEmitter = new vscode.EventEmitter<void>();
	private readonly baselineEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly summaryEmitter = new vscode.EventEmitter<string>();
	private lastSummary = "";
	/** Bumped by `clear`, so tool events received before it are dropped. */
	private generation = 0;

	readonly onDidChangeTreeData = this.treeEmitter.event;
	/** Fires with the new {@link summary} when it changes. */
	readonly onDidChangeSummary = this.summaryEmitter.event;
	/** Fires with the `omp-base:` uri whose content changed. */
	readonly onDidChangeBaseline = this.baselineEmitter.event;
	/** Serves `omp-base:` documents for the diff editor. */
	readonly contentProvider: BaselineContentProvider;

	constructor(
		private readonly logger: Logger,
		read: ReadSnapshot = filePath => readSnapshot(filePath, logger),
	) {
		this.model = new ChangeModel(read, logger);
		this.contentProvider = new BaselineContentProvider(filePath => this.model.baseline(filePath), this.onDidChangeBaseline);
		this.treeEmitter.event(() => {
			const summary = changesSummary(this.model.size);
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
		return this.model.changes;
	}

	setService(service: OmpServiceApi | undefined): void {
		this.subscriptions.forEach(subscription => subscription.dispose());
		this.service = service;
		this.sessionId = service?.session.sessionId;
		this.subscriptions = service
			? [
					service.onToolExecution(event => {
						const cwd = service.cwd;
						if (!cwd) return;
						const scope: ChangeScope = { cwd, roots: workspaceRoots(cwd) };
						const generation = this.generation;
						this.model.readAhead(event, scope);
						this.queue = this.queue
							.then(() => (generation === this.generation ? this.handle(event, scope) : undefined))
							.catch(error => this.logger.error("Change tracking failed", error));
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

	/** Forgets all changes, including tool events not yet processed, and closes their diff editors, whose baselines are gone with them. */
	clear(): void {
		this.generation++;
		const staleDiffs = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === BASELINE_SCHEME);
		if (staleDiffs.length > 0) {
			vscode.window.tabGroups.close(staleDiffs).then(undefined, error => this.logger.error("Closing OMP change diffs failed", error));
		}
		this.model.clear();
		this.treeEmitter.fire();
	}

	async openDiff(target: TrackedChange | vscode.Uri): Promise<void> {
		const filePath = target instanceof vscode.Uri ? target.fsPath : target.path;
		const change = this.model.change(filePath);
		const right = change?.status === "D" ? baselineUri(filePath, EMPTY_QUERY) : vscode.Uri.file(filePath);
		const left = this.model.hasBaseline(filePath) ? baselineUri(filePath) : baselineUri(filePath, EMPTY_QUERY);
		await vscode.commands.executeCommand("vscode.diff", left, right, `${path.basename(filePath)} (OMP changes)`);
	}

	/**
	 * Native diff for one tool call: the tracked change when the file is tracked, else the
	 * tool's own `oldText` snapshot against the current file, after confirmation when that file
	 * is outside the workspace. `file` (a path as the webview got it from the call) narrows this
	 * to that file and must be one the call names. Returns false when there is nothing to show.
	 */
	async openToolDiff(item: Extract<TranscriptItem, { kind: "tool" }>, file?: string): Promise<boolean> {
		const cwd = this.service?.cwd;
		if (!cwd) return false;
		const wanted = file === undefined ? undefined : resolveToolPath(file, cwd);
		if (file !== undefined && !wanted) return false;
		const isWanted = (filePath: string | undefined): filePath is string => filePath !== undefined && (wanted === undefined || filePath === wanted);
		const files = toolResultFiles(item.result?.details);
		const candidates = [...files.map(entry => entry.path), ...toolArgPaths(item.args)].map(raw => resolveToolPath(raw, cwd)).filter(isWanted);
		if (candidates.length === 0) return false;
		const tracked = candidates.find(filePath => this.model.isTracked(filePath));
		if (tracked) {
			await this.openDiff(vscode.Uri.file(tracked));
			return true;
		}
		const withOld = files.find(entry => entry.oldText !== undefined && isWanted(resolveToolPath(entry.path, cwd)));
		if (withOld?.oldText === undefined) return false;
		const filePath = resolveToolPath(withOld.path, cwd);
		if (!filePath) return false;
		if (!(await confirmToolFile(filePath, cwd))) return true;
		const left = this.contentProvider.pin(filePath, withOld.oldText);
		await vscode.commands.executeCommand("vscode.diff", left, vscode.Uri.file(filePath), `${path.basename(filePath)} (OMP ${item.name})`);
		return true;
	}

	private async handle(event: ToolExecutionEvent, scope: ChangeScope): Promise<void> {
		const { changesChanged, baselinesChanged } = await this.model.apply(event, scope);
		for (const filePath of baselinesChanged) this.baselineEmitter.fire(baselineUri(filePath));
		if (changesChanged) this.treeEmitter.fire();
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
