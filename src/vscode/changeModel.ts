import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger, ToolExecutionEvent } from "../omp/api";
import { toolArgPaths, toolResultFiles } from "../shared/toolFiles";
import { isWithinRoots, lineDelta, resolveToolPath } from "./changePaths";

export interface TrackedChange {
	/** Absolute filesystem path. */
	path: string;
	status: "A" | "M" | "D";
	added: number;
	removed: number;
}

/** File content, `null` when the file does not exist, `undefined` when it cannot be tracked. */
export type Snapshot = string | null | undefined;

export type ReadSnapshot = (filePath: string) => Promise<Snapshot>;

/** What changed in the model after one tool event. */
export interface ApplyResult {
	/** The set of tracked changes or one of their rows changed. */
	changesChanged: boolean;
	/** Paths whose baseline content changed. */
	baselinesChanged: string[];
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ast_grep", "find", "lsp", "debug", "fetch", "web_search"]);
export const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
/** Total baseline text kept per session. */
const MAX_BASELINE_CHARS = 64 * 1024 * 1024;

/** Where tool paths resolve (`cwd`) and which directories may be tracked (`roots`). */
export interface ChangeScope {
	cwd: string;
	roots: readonly string[];
}

/** Reads a file for change tracking. */
export async function readSnapshot(filePath: string, logger: Logger): Promise<Snapshot> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) {
			logger.debug(`Not tracking ${filePath}: not a regular file`);
			return undefined;
		}
		if (stat.size > MAX_SNAPSHOT_BYTES) {
			logger.debug(`Not tracking ${filePath}: ${stat.size} bytes exceeds the ${MAX_SNAPSHOT_BYTES}-byte snapshot limit`);
			return undefined;
		}
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		logger.warn(`Cannot snapshot ${filePath}`, error);
		return undefined;
	}
}

/**
 * Map keyed by absolute file path. Windows paths are case-insensitive and VS Code
 * lowercases the drive letter in `Uri.fsPath`, so keys are compared case-insensitively
 * there; `keys()` returns each path as first seen.
 */
class PathMap<V> {
	private readonly entries = new Map<string, { path: string; value: V }>();

	private static key(filePath: string): string {
		return process.platform === "win32" ? path.win32.normalize(filePath).toLowerCase() : filePath;
	}

	get size(): number {
		return this.entries.size;
	}

	has(filePath: string): boolean {
		return this.entries.has(PathMap.key(filePath));
	}

	get(filePath: string): V | undefined {
		return this.entries.get(PathMap.key(filePath))?.value;
	}

	set(filePath: string, value: V): void {
		const key = PathMap.key(filePath);
		this.entries.set(key, { path: this.entries.get(key)?.path ?? filePath, value });
	}

	delete(filePath: string): boolean {
		return this.entries.delete(PathMap.key(filePath));
	}

	clear(): void {
		this.entries.clear();
	}

	keys(): string[] {
		return [...this.entries.values()].map(entry => entry.path);
	}

	values(): V[] {
		return [...this.entries.values()].map(entry => entry.value);
	}
}

/**
 * Baselines and changes of files touched by OMP tools: the first-seen content of each
 * file and how the file on disk differs from it now.
 */
export class ChangeModel {
	/** Baseline content per absolute path; `null` = file did not exist. */
	private readonly baselines = new PathMap<string | null>();
	/**
	 * Tool call whose start snapshot set each baseline. A start event can arrive after OMP
	 * already wrote the file, so that call's own reported `oldText` replaces its snapshot.
	 */
	private readonly baselineSource = new PathMap<string>();
	private readonly byPath = new PathMap<TrackedChange>();
	/** Tool calls that started and have not ended. */
	private readonly running = new Set<string>();
	/** Reads begun by {@link readAhead}, per tool call and path, until `apply` takes them. */
	private readonly readsAhead = new Map<string, Map<string, Promise<Snapshot>>>();
	/** Characters held by `baselines`. */
	private retainedChars = 0;
	/** Bumped by `clear`, so an `apply` that was awaiting a read then drops its results. */
	private generation = 0;

	constructor(
		private readonly read: ReadSnapshot,
		private readonly logger: Logger,
		private readonly maxBaselineChars = MAX_BASELINE_CHARS,
	) {}

	get changes(): TrackedChange[] {
		return this.byPath.values();
	}

	get size(): number {
		return this.byPath.size;
	}

	isTracked(filePath: string): boolean {
		return this.byPath.has(filePath);
	}

	change(filePath: string): TrackedChange | undefined {
		return this.byPath.get(filePath);
	}

	hasBaseline(filePath: string): boolean {
		return this.baselines.has(filePath);
	}

	/** First-seen content; `null` when the file did not exist, `undefined` when unknown. */
	baseline(filePath: string): string | null | undefined {
		return this.baselines.get(filePath);
	}

	/** Forgets everything, including the results of an `apply` still in progress. */
	clear(): void {
		this.baselines.clear();
		this.baselineSource.clear();
		this.byPath.clear();
		this.running.clear();
		this.readsAhead.clear();
		this.retainedChars = 0;
		this.generation++;
	}

	/**
	 * Starts reading the files a starting tool names as soon as its event arrives. Events are applied
	 * one after another, and OMP may write a file while earlier events are still being applied, so a
	 * read begun only when `apply` reaches the start event could see the tool's own write.
	 */
	readAhead(event: ToolExecutionEvent, scope: ChangeScope): void {
		if (event.phase !== "start" || READ_ONLY_TOOLS.has(event.name)) return;
		const reads = new Map<string, Promise<Snapshot>>();
		for (const raw of toolArgPaths(event.args)) {
			const filePath = resolveToolPath(raw, scope.cwd);
			if (filePath !== undefined && isWithinRoots(filePath, scope.roots) && !this.baselines.has(filePath)) reads.set(filePath, this.read(filePath));
		}
		if (reads.size > 0) this.readsAhead.set(event.toolCallId, reads);
	}

	/** Applies one tool event; a start event uses the reads {@link readAhead} began for it. */
	async apply(event: ToolExecutionEvent, scope: ChangeScope): Promise<ApplyResult> {
		const result: ApplyResult = { changesChanged: false, baselinesChanged: [] };
		const generation = this.generation;
		const readsAhead = this.readsAhead.get(event.toolCallId);
		this.readsAhead.delete(event.toolCallId);
		if (READ_ONLY_TOOLS.has(event.name)) return result;
		const resolve = (raw: string): string | undefined => {
			const filePath = resolveToolPath(raw, scope.cwd);
			if (filePath === undefined || isWithinRoots(filePath, scope.roots)) return filePath;
			this.logger.debug(`Not tracking ${filePath}: outside the workspace`);
			return undefined;
		};
		const argPaths = toolArgPaths(event.args)
			.map(resolve)
			.filter((p): p is string => p !== undefined);
		if (event.phase === "start") {
			this.running.add(event.toolCallId);
			for (const filePath of argPaths) {
				if (this.baselines.has(filePath)) continue;
				const content = await (readsAhead?.get(filePath) ?? this.read(filePath));
				if (generation !== this.generation) return { changesChanged: false, baselinesChanged: [] };
				if (content === undefined || !this.admit(filePath, content, result)) continue;
				this.setBaseline(filePath, content);
				this.baselineSource.set(filePath, event.toolCallId);
			}
			return result;
		}
		this.running.delete(event.toolCallId);
		const reported = new Map<string, string | undefined>();
		for (const file of toolResultFiles(event.result?.details)) {
			const resolved = resolve(file.path);
			if (resolved && !reported.has(resolved)) reported.set(resolved, file.oldText);
		}
		for (const [filePath, oldText] of reported) {
			if (typeof oldText !== "string" || this.baselineSource.get(filePath) !== event.toolCallId) continue;
			// No file at the start snapshot and an empty `oldText`: the call created the file.
			if (oldText === "" && this.baselines.get(filePath) === null) continue;
			this.setBaseline(filePath, oldText);
			result.baselinesChanged.push(filePath);
		}
		const candidates = new Set([...argPaths.filter(p => this.baselines.has(p)), ...reported.keys()]);
		for (const filePath of candidates) {
			const current = await this.read(filePath);
			if (generation !== this.generation) return { changesChanged: false, baselinesChanged: [] };
			if (current === undefined) continue;
			if (!this.baselines.has(filePath)) {
				const oldText = reported.get(filePath);
				if (oldText === undefined) {
					this.logger.debug(`Not tracking ${filePath}: its content before ${event.name} ran is unknown`);
					continue;
				}
				if (!this.admit(filePath, oldText, result)) continue;
				this.setBaseline(filePath, oldText);
				result.baselinesChanged.push(filePath);
			}
			const before = this.baselines.get(filePath) ?? null;
			if (before === current) {
				result.changesChanged = this.byPath.delete(filePath) || result.changesChanged;
				continue;
			}
			const status = before === null ? "A" : current === null ? "D" : "M";
			this.byPath.set(filePath, { path: filePath, status, ...lineDelta(before, current) });
			result.changesChanged = true;
		}
		return result;
	}

	private setBaseline(filePath: string, content: string | null): void {
		this.retainedChars += (content?.length ?? 0) - (this.baselines.get(filePath)?.length ?? 0);
		this.baselines.set(filePath, content);
	}

	/**
	 * Makes room for a new baseline by forgetting baselines of files that are unchanged and
	 * not being written by a running tool (a later touch snapshots them again). False when
	 * the baselines of changed files alone leave no room.
	 */
	private admit(filePath: string, content: string | null, result: ApplyResult): boolean {
		const size = content?.length ?? 0;
		for (const candidate of this.baselines.keys()) {
			if (this.retainedChars + size <= this.maxBaselineChars) return true;
			if (this.byPath.has(candidate)) continue;
			const source = this.baselineSource.get(candidate);
			if (source !== undefined && this.running.has(source)) continue;
			this.retainedChars -= this.baselines.get(candidate)?.length ?? 0;
			this.baselines.delete(candidate);
			this.baselineSource.delete(candidate);
			result.baselinesChanged.push(candidate);
		}
		if (this.retainedChars + size <= this.maxBaselineChars) return true;
		this.logger.warn(`Not tracking changes to ${filePath}: baselines already hold ${this.retainedChars} characters (limit ${this.maxBaselineChars})`);
		return false;
	}
}
