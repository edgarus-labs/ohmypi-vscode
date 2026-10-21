import type { ToolResultView, TranscriptItem } from "../omp/api";
import { errorMessage } from "../shared/errors";
import { formatDuration } from "../shared/format";
import { isRecord } from "../shared/guards";
import { toolArgPaths, toolResultFiles } from "../shared/toolFiles";
import { codeBlock, diffView, linkButton, proseBlock, type RowView } from "./codeBlock";
import type { RenderContext } from "./context";
import { type Child, h } from "./dom";
import { guessLanguage } from "./highlight";
import { type IconName, icon } from "./icons";
import { flatArgs, flatLines, indentedJson, looksLikeDiff, looksLikeMarkdown, prettyJson, splitLineNumbers, stripFences, stripShellTrailer } from "./toolText";

export type RendererKind = "file" | "search" | "shell" | "task" | "lsp" | "mcp" | "job" | "generic";

const RENDERER_BY_NAME: Record<string, RendererKind> = {
	read: "file",
	write: "file",
	edit: "file",
	ast_edit: "file",
	grep: "search",
	glob: "search",
	ast_grep: "search",
	bash: "shell",
	eval: "shell",
	task: "task",
	lsp: "lsp",
	debug: "lsp",
	job: "job",
	await: "job",
	cancel_job: "job",
};

export function pickRenderer(name: string): RendererKind {
	if (name.startsWith("mcp__")) return "mcp";
	return Object.hasOwn(RENDERER_BY_NAME, name) ? RENDERER_BY_NAME[name] : "generic";
}

const SUMMARY_KEYS = ["action", "command", "pattern", "query", "url", "path", "file", "agent"];
const LIST_KEYS = ["paths", "ids"];
const MAX_SUMMARY = 120;

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat;
}

function taskNames(tasks: unknown[]): string[] {
	return tasks.map((task, index) => {
		if (!isRecord(task)) return `#${index + 1}`;
		const label = [task.name, task.agent, task.id].find(value => typeof value === "string" && value);
		return typeof label === "string" ? label : `#${index + 1}`;
	});
}

/** One-line description of a tool call from its arguments; never throws. */
export function summarizeTool(name: string, args: unknown): string {
	if (typeof args === "string") return oneLine(args);
	if (typeof args === "number" || typeof args === "boolean") return String(args);
	if (!isRecord(args)) return "";
	if (name === "task" && Array.isArray(args.tasks)) {
		const count = args.tasks.length;
		return oneLine(`${count} task${count === 1 ? "" : "s"}: ${taskNames(args.tasks).join(", ")}`);
	}
	const parts = SUMMARY_KEYS.map(key => args[key]).filter((value): value is string => typeof value === "string" && value.trim() !== "");
	if (parts.length > 0) return oneLine(parts.slice(0, 2).join(" · "));
	for (const key of LIST_KEYS) {
		const list = args[key];
		if (Array.isArray(list)) return oneLine(list.filter(value => typeof value === "string").join(", "));
	}
	const firstString = Object.values(args).find(value => typeof value === "string");
	return typeof firstString === "string" ? oneLine(firstString) : "";
}

/** `mcp__server__tool` → server and tool; a name joined with single underscores stays whole, as its server name may contain them. */
export function splitMcpName(name: string): { server: string; tool: string } {
	const rest = name.startsWith("mcp__") ? name.slice(5) : name;
	const index = rest.indexOf("__");
	return index < 0 ? { server: rest, tool: "" } : { server: rest.slice(0, index), tool: rest.slice(index + 2) };
}

const HIT_COUNT_KEYS = ["matchCount", "totalMatches", "count", "fileCount"];

export function hitCount(result: ToolResultView | undefined): number | undefined {
	if (!result) return undefined;
	const details = result.details;
	if (isRecord(details)) {
		for (const key of HIT_COUNT_KEYS) {
			const value = details[key];
			if (typeof value === "number") return value;
		}
	}
	return result.text.split("\n").filter(line => line.trim() !== "").length;
}

export function exitCodeOf(result: ToolResultView | undefined): number | undefined {
	const details = result?.details;
	return isRecord(details) && typeof details.exitCode === "number" ? details.exitCode : undefined;
}

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** What a call really is: running, failed, a job it only started in the background (its result acknowledges the start), done, or never resolved. */
export type ToolState = "running" | "done" | "error" | "unresolved" | "background";

/** {@link ToolState} from the call's status and result flag alone, without reading its details. */
function statusState(item: ToolItem): ToolState {
	if (item.status === "running" || item.status === "unresolved") return item.status;
	return item.status === "error" || item.result?.isError === true ? "error" : "done";
}

/** The call's state; a finished call whose `result.details.async.state` is `running` still works in the background. */
export function toolState(item: ToolItem): ToolState {
	const state = statusState(item);
	if (state !== "done") return state;
	const details = item.result?.details;
	const job = isRecord(details) ? details.async : undefined;
	return isRecord(job) && job.state === "running" ? "background" : "done";
}

// ── Headline (the header row) ────────────────────────────────────────────────

export interface ToolHeadline {
	/** Display name (`server › tool` for MCP tools). */
	name: string;
	/** Primary argument on one line (path, quoted pattern, command or the call's description, …). */
	primary: string;
	/** `…` running or in the background, `✓` done, `✗` failed, `?` no result recorded. */
	glyph: string;
	state: ToolState;
	/** Hits / exit code / written lines and duration (or `in background`), joined by ` · `. */
	detail: string;
	/** First non-empty line of an error result. */
	error?: string;
	/** The call's only file when the primary argument names it; the header links it. */
	file?: { path: string; line?: number };
}

const MAX_ERROR_LINE = 160;

const GLYPH: Record<ToolState, string> = { running: "…", background: "…", unresolved: "?", error: "✗", done: "✓" };

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function argsOf(item: ToolItem): Record<string, unknown> {
	return isRecord(item.args) ? item.args : {};
}

function shellCommand(item: ToolItem): string {
	const args = argsOf(item);
	return str(args.command) ?? str(args.code) ?? str(args.input) ?? summarizeTool(item.name, item.args);
}

const DESCRIPTION_KEYS = ["i", "title"];

/** What the agent said a call is for (OMP's `i` intent or an `eval` title). */
function toolDescription(item: ToolItem): string | undefined {
	const args = argsOf(item);
	return DESCRIPTION_KEYS.map(key => str(args[key])).find(value => value !== undefined);
}

function searchScope(args: Record<string, unknown>): string | undefined {
	return str(args.path) ?? (Array.isArray(args.paths) ? args.paths.filter(p => typeof p === "string").join(", ") || undefined : undefined);
}

function primaryArg(item: ToolItem, kind: RendererKind): string {
	const args = argsOf(item);
	switch (kind) {
		case "file": {
			const details = isRecord(item.result?.details) ? item.result.details : {};
			return oneLine(str(args.path) ?? str(args.file) ?? str(details.path) ?? str(details.resolvedPath) ?? summarizeTool(item.name, item.args));
		}
		case "search": {
			const pattern = str(args.pattern) ?? str(args.query) ?? summarizeTool(item.name, item.args);
			const where = searchScope(args);
			return pattern ? oneLine(`"${pattern}"${where ? ` in ${where}` : ""}`) : "";
		}
		case "shell":
			return oneLine(toolDescription(item) ?? shellCommand(item));
		case "lsp":
			return oneLine([str(args.action) ?? str(args.op), str(args.file) ?? str(args.path)].filter(Boolean).join(" ")) || summarizeTool(item.name, item.args);
		default:
			return summarizeTool(item.name, item.args);
	}
}

function errorLine(result: ToolResultView | undefined): string | undefined {
	if (!result?.isError) return undefined;
	const line = result.text
		.split("\n")
		.map(candidate => candidate.trim())
		.find(Boolean);
	if (!line) return undefined;
	return line.length > MAX_ERROR_LINE ? `${line.slice(0, MAX_ERROR_LINE - 1)}…` : line;
}

/**
 * Rewrites paths under `cwd` as relative paths. A Windows `cwd` (drive letter or backslashes) matches either
 * separator and any letter case; a POSIX one matches exactly.
 */
function relativeTo(text: string, cwd: string | undefined): string {
	if (!cwd) return text;
	const windows = /^[a-z]:|\\/i.test(cwd);
	const separator = windows ? String.raw`[\\/]` : "/";
	const parts = cwd.replace(/[\\/]+$/, "").split(windows ? /[\\/]/ : "/");
	const root = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(separator) + separator;
	return text.replace(new RegExp(`(^|[\\s"'(])${root}`, windows ? "gi" : "g"), "$1");
}

/** Label of a file link: the path relative to `cwd` when inside it, plus `:line`. */
export function fileLinkLabel(path: string, line: number | undefined, cwd: string | undefined): string {
	const shown = relativeTo(path, cwd);
	return line ? `${shown}:${line}` : shown;
}

/** The header's file: the call's only file, when the primary argument is its link label alone or followed by a selector. */
function headerFile(item: ToolItem, kind: RendererKind, primary: string, cwd: string | undefined): ToolFile | undefined {
	if (kind !== "file") return undefined;
	const files = toolFiles(item, cwd);
	if (files.length !== 1) return undefined;
	const label = fileLinkLabel(files[0].path, undefined, cwd);
	return primary === label || primary.startsWith(`${label}:`) ? files[0] : undefined;
}

/** Everything a tool row's header shows; pure and never throws. */
export function toolHeadline(item: ToolItem, cwd?: string): ToolHeadline {
	let state = statusState(item);
	try {
		const kind = pickRenderer(item.name);
		state = toolState(item);
		const { server, tool } = splitMcpName(item.name);
		const name = kind === "mcp" ? (tool ? `${server} › ${tool}` : server) : item.name;
		const parts: string[] = [];
		if (kind === "search" && item.status === "done" && state !== "error") {
			const hits = hitCount(item.result);
			if (hits !== undefined) parts.push(plural(hits, "hit"));
		}
		const exit = kind === "shell" ? exitCodeOf(item.result) : undefined;
		if (exit !== undefined) parts.push(`exit ${exit}`);
		if (item.name === "write" && isRecord(item.args) && typeof item.args.content === "string") parts.push(plural(item.args.content.split("\n").length, "line"));
		if (state === "background") parts.splice(0, parts.length, "in background");
		else if (item.endedAt !== undefined && item.startedAt > 0 && item.endedAt >= item.startedAt) parts.push(formatDuration(item.endedAt - item.startedAt));
		const primary = relativeTo(primaryArg(item, kind), cwd);
		const headline: ToolHeadline = { name, primary, glyph: GLYPH[state], state, detail: parts.join(" · ") };
		const file = headerFile(item, kind, primary, cwd);
		if (file) headline.file = file.line === undefined ? { path: file.path } : { path: file.path, line: file.line };
		const error = errorLine(item.result);
		return error ? { ...headline, error } : headline;
	} catch (error) {
		return { name: item.name, primary: "", glyph: GLYPH[state], state, detail: "", error: `Could not summarize this call: ${errorMessage(error)}` };
	}
}

// ── Files ────────────────────────────────────────────────────────────────────

/**
 * Trailing `read` selector parts: `:12`, `:12-40`, `:50+150`, `:5-16,960-973`, `:-60` (tail), the modes `:raw`,
 * `:conflicts` and `:img`, and video times (`:1h5m42s`, `:90s`).
 */
const SELECTOR_SUFFIX = /:(raw|conflicts|img|\d+h(?:\d+m)?(?:\d+s)?|\d+m(?:\d+s)?|\d+s|-\d+|\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*)$/;

/** A path with `read` selectors → the path and the first line the selectors start at. */
export function splitSelector(raw: string): { path: string; line?: number } {
	let path = raw;
	let line: number | undefined;
	for (let match = SELECTOR_SUFFIX.exec(path); match && match.index > 0; match = SELECTOR_SUFFIX.exec(path)) {
		const first = /^\d+(?=$|[-+,])/.exec(match[1]);
		if (first) line = Number(first[0]);
		path = path.slice(0, match.index);
	}
	return line === undefined ? { path } : { path, line };
}

/** The call's diff; a multi-file edit's per-file diffs each under a `--- path` / `+++ path` header. */
function collectDiff(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	if (Array.isArray(details.perFileResults)) {
		const diffs = details.perFileResults.flatMap(entry => {
			if (!isRecord(entry)) return [];
			const diff = str(entry.diff);
			const path = str(entry.path) ?? "";
			return diff === undefined ? [] : [`--- ${path}`, `+++ ${path}`, diff];
		});
		if (diffs.length > 0) return diffs.join("\n");
	}
	return str(details.diff);
}

/** The file a file tool works on and the line to open it at, from its arguments or result details. */
function fileTarget(item: ToolItem): { path: string; line?: number } | undefined {
	const args = argsOf(item);
	const details = isRecord(item.result?.details) ? item.result.details : {};
	const raw = str(args.path) ?? str(args.file) ?? str(details.path) ?? str(details.resolvedPath);
	if (!raw) return undefined;
	const target = splitSelector(raw);
	const line = num(details.firstChangedLine) ?? num(args.line) ?? num(args.offset) ?? target.line;
	return line === undefined ? { path: target.path } : { path: target.path, line };
}

/** A file a tool call names, as the call wrote its path; `oldText` when the result recorded the file's content before the call. */
export interface ToolFile {
	path: string;
	line?: number;
	oldText?: string;
}

const SLASHED_ROOT = /^(?:[a-z][a-z0-9+.-]*:|\/|~\/)/i;

/** Identity of a tool path for comparing paths the call wrote differently: resolved against `cwd`, `/`-separated, lower case. */
function pathKey(raw: string, cwd: string | undefined): string {
	const slashed = raw.trim().replace(/\\/g, "/");
	if (!cwd || SLASHED_ROOT.test(slashed)) return slashed.toLowerCase();
	return `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${slashed.replace(/^(?:\.\/)+/, "")}`.toLowerCase();
}

/**
 * Every file a tool call names: the file target first (with its line), then the other argument paths (multi-file
 * edits, patches) and result paths, one entry per file.
 */
function toolFiles(item: ToolItem, cwd: string | undefined): ToolFile[] {
	const results = toolResultFiles(item.result?.details);
	const files: ToolFile[] = [];
	const seen = new Set<string>();
	const add = (raw: string, line?: number) => {
		const key = pathKey(raw, cwd);
		if (seen.has(key)) return;
		seen.add(key);
		const oldText = results.find(result => result.oldText !== undefined && pathKey(result.path, cwd) === key)?.oldText;
		files.push({ path: raw, ...(line === undefined ? {} : { line }), ...(oldText === undefined ? {} : { oldText }) });
	};
	const target = fileTarget(item);
	if (target) add(target.path, target.line);
	for (const raw of toolArgPaths(item.args)) add(splitSelector(raw).path);
	for (const result of results) add(result.path);
	return files;
}

const CHANGES_FILES: Record<string, true> = { write: true, edit: true, ast_edit: true };

export type FileAction = { kind: "open"; path: string; line: number | undefined } | { kind: "diff"; path: string; label: string };

/**
 * A link per file the call names (except the header's file) and a Diff where the host can show a real one: the
 * call changed files (it recorded a diff, or it is a writing tool that did not fail), has finished, and the file
 * either lies in the working directory, where the host tracks changes, or has its old text recorded by the call.
 */
export function fileActions(item: ToolItem, cwd: string | undefined): FileAction[] {
	const inHeader = toolHeadline(item, cwd).file;
	const changesFiles = collectDiff(item.result?.details) !== undefined || (CHANGES_FILES[item.name] === true && statusState(item) !== "error");
	const files = toolFiles(item, cwd);
	const root = cwd === undefined ? undefined : `${pathKey(cwd, undefined).replace(/\/+$/, "")}/`;
	const actions: FileAction[] = [];
	for (const file of files) {
		if (inHeader?.path !== file.path) actions.push({ kind: "open", path: file.path, line: file.line });
		const tracked = root === undefined || pathKey(file.path, cwd).startsWith(root);
		if (!changesFiles || item.status === "running" || (file.oldText === undefined && !tracked)) continue;
		actions.push({ kind: "diff", path: file.path, label: files.length === 1 ? "Diff" : `Diff ${fileLinkLabel(file.path, undefined, cwd)}` });
	}
	return actions;
}

// ── Body decisions ───────────────────────────────────────────────────────────

/** The extension of the file a file tool names (lower case, without the dot): the language of its result. */
function fileLanguage(item: ToolItem): string | undefined {
	if (pickRenderer(item.name) !== "file") return undefined;
	const args = argsOf(item);
	const raw = str(args.path) ?? str(args.file) ?? str(args.file_path);
	if (!raw) return undefined;
	const name = splitSelector(raw).path.split(/[\\/]/).pop() ?? "";
	const dot = name.lastIndexOf(".");
	return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : undefined;
}

/** The text a result renders as: a numbered file listing loses its header and line-number prefixes first. */
function proseText(text: string): string {
	return splitLineNumbers(text)?.code ?? text;
}

/**
 * Whether a call's result renders as Markdown prose rather than code: a read of a Markdown file (or of a `://`
 * resource that looks like Markdown), or an MCP or generic tool whose result looks like Markdown; never a failed call.
 */
export function rendersMarkdown(item: ToolItem): boolean {
	const text = item.result?.text;
	if (text === undefined || item.result?.isError === true) return false;
	if (item.name === "read") {
		const language = fileLanguage(item);
		return language === "md" || language === "markdown" || ((str(argsOf(item).path) ?? "").includes("://") && looksLikeMarkdown(text));
	}
	const kind = pickRenderer(item.name);
	return (kind === "mcp" || kind === "generic") && looksLikeMarkdown(text);
}

/** A group holding a quantifier that is itself repeated (`(a+)+`, `(\w*)*`): JavaScript regexes can backtrack on it without bound. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,\d*\})\)(?:[+*]|\{\d+,\d*\})/;

/**
 * What a search call looked for, to mark in its result: its pattern as a regex, or as literal text when it is not a
 * valid one or could backtrack without bound, ignoring case when the call sets `case` to false; `undefined` for other
 * tools or a call without a pattern.
 */
export function searchPattern(item: ToolItem): RegExp | undefined {
	if (pickRenderer(item.name) !== "search") return undefined;
	const args = argsOf(item);
	const pattern = str(args.pattern);
	if (!pattern) return undefined;
	const ignoreCase = args.case === false ? "i" : "";
	const literal = () => new RegExp(pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), `g${ignoreCase}`);
	if (NESTED_QUANTIFIER.test(pattern)) return literal();
	try {
		return new RegExp(pattern, `gm${ignoreCase}`);
	} catch {
		return literal();
	}
}

/** How a call's result shows: a diff, Markdown prose, or code (`shown` for display, `copy` what copying all yields). */
export type OutputView =
	| { kind: "diff"; text: string }
	| { kind: "markdown"; source: string }
	| { kind: "code"; shown: string; copy: string; language: string | undefined; mark: RegExp | undefined };

/**
 * The result view: diff-looking output of a finished, successful call as a diff; Markdown results as prose; else
 * code without its fences, single-line JSON indented, shell output without OMP's trailer, colored in the language
 * of its first fence, else of the file it came from, else a guessed one. Running output shows as it comes.
 */
export function outputView(item: ToolItem, shell = false): OutputView | undefined {
	const text = item.result?.text ?? item.partial ?? "";
	if (!text) return undefined;
	const running = item.status === "running";
	const mark = searchPattern(item);
	if (running) return { kind: "code", shown: text, copy: text, language: undefined, mark };
	if (item.result?.isError !== true && looksLikeDiff(text)) return { kind: "diff", text };
	if (rendersMarkdown(item)) return { kind: "markdown", source: proseText(text) };
	const { text: unfenced, language: fence } = stripFences(text);
	const shown = prettyJson(unfenced) ?? (shell ? stripShellTrailer(unfenced) : unfenced);
	return { kind: "code", shown, copy: text, language: fence ?? fileLanguage(item) ?? guessLanguage(proseText(shown)), mark };
}

/** Whether the header's one-line summary shows `command` whole: a single line without extra whitespace that is not cut. */
function fitsHeader(command: string): boolean {
	return command.length <= MAX_SUMMARY && command.replace(/\s+/g, " ").trim() === command;
}

export interface ShellInput {
	/** The command and its language, when the header does not show it whole. */
	command?: { text: string; language: string | undefined };
	/** The other arguments, one `name: value` per line. */
	parameters?: string;
}

/**
 * What a shell call's IN shows: the command when the call has a description (the header shows that instead) or the
 * command does not fit the header, and the arguments other than the command and description; `undefined` for neither.
 */
export function shellInput(item: ToolItem): ShellInput | undefined {
	const args = argsOf(item);
	const command = shellCommand(item);
	const description = toolDescription(item);
	const showCommand = description !== undefined || !fitsHeader(command);
	const commandKey = ["command", "code", "input"].find(key => str(args[key]) !== undefined);
	const descriptionKey = DESCRIPTION_KEYS.find(key => str(args[key]) !== undefined);
	const parameters = flatLines(Object.entries(args).filter(([name]) => name !== commandKey && name !== descriptionKey));
	if (!showCommand && !parameters) return undefined;
	const language = item.name === "eval" ? str(args.language) : item.name === "bash" ? "bash" : undefined;
	return { ...(showCommand ? { command: { text: command, language } } : {}), ...(parameters ? { parameters } : {}) };
}

// ── DOM rendering ────────────────────────────────────────────────────────────

/** A body part with a short IN / OUT label in a narrow column at its left; `null` without content. */
function labeled(label: string, content: HTMLElement | null): HTMLElement | null {
	return content ? h("div", { class: "tool-part" }, h("span", { class: "tool-label" }, label), h("div", { class: "tool-content" }, content)) : null;
}

/** The call's arguments as `name: value` lines (copying all yields indented JSON); `null` for a call without any. */
function argsSection(item: ToolItem, row: RowView): HTMLElement | null {
	const args = item.args;
	if (args === undefined || args === null || (typeof args === "object" && Object.keys(args).length === 0)) return null;
	return labeled("IN", codeBlock(row, flatArgs(args), { copy: indentedJson(args), language: "yaml", className: "quiet" }));
}

function outputSection(item: ToolItem, row: RowView, shell = false): HTMLElement | null {
	const view = outputView(item, shell);
	switch (view?.kind) {
		case undefined:
			return null;
		case "diff":
			return labeled("OUT", diffView(row, `${item.id}:out:more`, view.text));
		case "markdown":
			return labeled("OUT", proseBlock(row, view.source));
		case "code":
			return labeled("OUT", codeBlock(row, view.shown, { copy: view.copy, language: view.language, mark: view.mark }));
	}
}

function actionsLine(...children: Child[]): HTMLElement | null {
	return children.some(Boolean) ? h("div", { class: "tool-actions" }, ...children) : null;
}

function fileLink(ctx: RenderContext, path: string, line?: number): HTMLElement {
	return h(
		"button",
		{ class: "link path", title: `Open ${line ? `${path}:${line}` : path}`, attrs: { type: "button" }, onClick: () => ctx.post({ type: "openFile", path, line }) },
		fileLinkLabel(path, line, ctx.cwd),
	);
}

type Body = (item: ToolItem, row: RowView) => Child[];

const genericBody: Body = (item, row) => [argsSection(item, row), outputSection(item, row)];

const fileBody: Body = (item, row) => {
	const { ctx } = row;
	const diff = collectDiff(item.result?.details);
	const links = fileActions(item, ctx.cwd).map(action =>
		action.kind === "open"
			? fileLink(ctx, action.path, action.line)
			: h("button", { class: "link", title: "Open native diff", attrs: { type: "button" }, onClick: () => ctx.post({ type: "openDiff", toolCallId: item.id, path: action.path }) }, action.label),
	);
	return [
		actionsLine(...links),
		diff ? diffView(row, `${item.id}:diff:more`, diff) : null,
		item.name !== "read" && !diff ? argsSection(item, row) : null,
		item.name === "read" || item.result?.isError || !diff ? outputSection(item, row) : null,
	];
};

const shellBody: Body = (item, row) => {
	const input = shellInput(item);
	const command = input?.command ? codeBlock(row, input.command.text, { language: input.command.language, className: "quiet" }) : null;
	const parameters = input?.parameters ? codeBlock(row, input.parameters, { language: "yaml", className: "quiet parameters" }) : null;
	return [command || parameters ? labeled("IN", h("div", { class: "tool-input" }, command, parameters)) : null, outputSection(item, row, true)];
};

const taskBody: Body = (item, row) => {
	const args = argsOf(item);
	const names = Array.isArray(args.tasks) ? taskNames(args.tasks) : [];
	const showAgents = () => row.ctx.post({ type: "showAgents" });
	return [
		actionsLine(h("button", { class: "link", attrs: { type: "button" }, onClick: showAgents }, "Agents")),
		names.length > 0 ? h("ul", { class: "task-list" }, ...names.map(name => h("li", undefined, h("button", { class: "link", attrs: { type: "button" }, onClick: showAgents }, name)))) : null,
		outputSection(item, row),
	];
};

const lspBody: Body = (item, row) => {
	const args = argsOf(item);
	const file = str(args.file) ?? str(args.path);
	return [actionsLine(file ? fileLink(row.ctx, file, num(args.line)) : null), argsSection(item, row), outputSection(item, row)];
};

const mcpBody: Body = (item, row) => [h("div", { class: "meta" }, item.name), ...genericBody(item, row)];

const BODIES: Record<RendererKind, Body> = {
	file: fileBody,
	search: genericBody,
	shell: shellBody,
	task: taskBody,
	lsp: lspBody,
	mcp: mcpBody,
	job: genericBody,
	generic: genericBody,
};

const TOOL_STATE: Record<ToolState, { icon: IconName; label: string; title: string }> = {
	running: { icon: "spinner", label: "running", title: "Running" },
	done: { icon: "check", label: "done", title: "Done" },
	error: { icon: "x", label: "failed", title: "Failed" },
	background: { icon: "clock", label: "running in the background", title: "started in the background, still running" },
	unresolved: { icon: "circleSlash", label: "no result", title: "No result was recorded for this call (interrupted, or still running elsewhere)" },
};

/** Status icon, name pill, primary argument (the header's file as a link) and the detail at the right; listener-free. */
function header(item: ToolItem, head: ToolHeadline): HTMLElement {
	const shell = pickRenderer(item.name) === "shell";
	const described = shell && toolDescription(item) !== undefined;
	return h(
		"div",
		{ class: "tool-head", attrs: { "data-part": "head" } },
		h("span", { class: "tool-status", title: TOOL_STATE[head.state].title, attrs: { role: "img", "aria-label": TOOL_STATE[head.state].label } }, icon(TOOL_STATE[head.state].icon, 14)),
		h("span", { class: "tool-name", title: item.name }, head.name),
		h(
			"span",
			{ class: `tool-primary${described ? " described" : ""}`, title: shell ? shellCommand(item) : head.primary },
			head.file
				? h("a", { class: "file-link", attrs: { href: "#", "data-path": head.file.path, ...(head.file.line ? { "data-line": String(head.file.line) } : {}) } }, head.primary)
				: head.primary,
		),
		head.detail ? h("span", { class: "tool-detail" }, head.detail) : null,
	);
}

/**
 * A tool call: the header row and under it, always visible, a dim preview of its input and result that "show more"
 * opens to the whole row (remembered per call). A finished `read` shows only its header and "show more (N lines)"
 * until opened. A failed call keeps its first error line under the header. The generic body stands in (with a note
 * why) when the specialized one throws. The header and error line carry `data-part` so an update of the same call
 * can be patched into this node.
 */
export function renderTool(item: ToolItem, ctx: RenderContext): HTMLElement {
	const head = toolHeadline(item, ctx.cwd);
	const key = `${item.id}:open`;
	const expanded = ctx.isOpen(key) === true;
	const headerOnly = item.name === "read" && head.state === "done";
	const refresh = (from: Element) => {
		const live = from.closest<HTMLElement>(".tool");
		if (!live) return;
		const fresh = renderTool(item, ctx);
		live.classList.toggle("expanded", fresh.classList.contains("expanded"));
		live.replaceChildren(...fresh.childNodes);
		return live;
	};
	const row: RowView = {
		ctx,
		expanded,
		closesToHeader: headerOnly,
		setExpanded: (from, open) => {
			ctx.setOpen(key, open);
			refresh(from)
				?.querySelector<HTMLElement>(`[data-action="${open ? "collapse" : "more"}"]`)
				?.focus();
		},
		refresh,
	};
	const el = h(
		"div",
		{ class: `tool status-${head.state}${expanded ? " expanded" : ""}`, attrs: { "data-tool": item.name } },
		header(item, head),
		head.error ? h("div", { class: "tool-error", title: head.error, attrs: { "data-part": "error" } }, head.error) : null,
	);
	if (!headerOnly || expanded) {
		let parts: Child[];
		try {
			parts = BODIES[pickRenderer(item.name)](item, row);
		} catch (error) {
			parts = [h("div", { class: "tool-fallback meta" }, `Specialized view failed (${errorMessage(error)}); showing raw arguments and output.`), ...genericBody(item, row)];
		}
		if (parts.some(Boolean)) el.append(h("div", { class: "tool-body" }, ...parts));
	}
	const text = item.result?.text ?? "";
	if (headerOnly && text) {
		const lines = proseText(text).replace(/[\r\n]+$/, "").split("\n").length;
		el.append(
			h(
				"div",
				{ class: "tool-more" },
				expanded
					? linkButton("collapse", button => row.setExpanded(button, false), "collapse")
					: linkButton(`show more (${plural(lines, "line")})`, button => row.setExpanded(button, true), "more"),
			),
		);
	}
	return el;
}
