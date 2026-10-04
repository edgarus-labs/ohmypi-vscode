import type { ToolResultView, TranscriptItem } from "../omp/api";
import { isRecord } from "../ui/guards";
import { type Child, collapsible, h, type OpenState } from "./dom";
import type { WebviewMessage } from "./protocol";

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

export function splitMcpName(name: string): { server: string; tool: string } {
	const rest = name.startsWith("mcp__") ? name.slice(5) : name;
	const separator = rest.includes("__") ? "__" : "_";
	const index = rest.indexOf(separator);
	return index < 0 ? { server: rest, tool: "" } : { server: rest.slice(0, index), tool: rest.slice(index + separator.length) };
}

export type DiffLineClass = "add" | "del" | "hunk" | "meta" | "ctx";

export function diffLineClass(line: string): DiffLineClass {
	if (line.startsWith("+++") || line.startsWith("---")) return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "del";
	if (line.startsWith("@@")) return "hunk";
	return "ctx";
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

// ── Headline (one collapsed row) ─────────────────────────────────────────────

export interface ToolHeadline {
	/** Display name (`server › tool` for MCP tools). */
	name: string;
	/** Primary argument on one line (path, quoted pattern, command, …). */
	primary: string;
	/** `…` running, `✓` done, `✗` failed. */
	glyph: string;
	/** Hits / exit code / written lines and duration, joined by ` · `. */
	detail: string;
	/** First non-empty line of an error result. */
	error?: string;
}

const MAX_ERROR_LINE = 160;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function durationText(item: ToolItem): string {
	if (item.endedAt === undefined) return "";
	const ms = item.endedAt - item.startedAt;
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function shellCommand(item: ToolItem): string {
	const args = isRecord(item.args) ? item.args : {};
	return str(args.command) ?? str(args.code) ?? str(args.input) ?? summarizeTool(item.name, item.args);
}

function searchScope(args: Record<string, unknown>): string | undefined {
	return str(args.path) ?? (Array.isArray(args.paths) ? args.paths.filter(p => typeof p === "string").join(", ") || undefined : undefined);
}

function primaryArg(item: ToolItem, kind: RendererKind): string {
	const args = isRecord(item.args) ? item.args : {};
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
			return oneLine(shellCommand(item));
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

/** Rewrites paths under `cwd` (POSIX or Windows separators) as relative paths. */
function relativeTo(text: string, cwd: string | undefined): string {
	if (!cwd) return text;
	const separator = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
	const root = cwd.endsWith(separator) ? cwd : cwd + separator;
	const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text.replace(new RegExp(`(^|[\\s"'(])${escaped}`, "g"), "$1");
}

/** Everything a collapsed tool row shows; pure and never throws. */
export function toolHeadline(item: ToolItem, cwd?: string): ToolHeadline {
	const failed = item.status === "error" || item.result?.isError === true;
	const glyph = item.status === "running" ? "…" : failed ? "✗" : "✓";
	const kind = pickRenderer(item.name);
	try {
		const { server, tool } = splitMcpName(item.name);
		const name = kind === "mcp" ? (tool ? `${server} › ${tool}` : server) : item.name;
		const parts: string[] = [];
		if (kind === "search" && item.status !== "running") {
			const hits = hitCount(item.result);
			if (hits !== undefined) parts.push(plural(hits, "hit"));
		}
		const exit = kind === "shell" ? exitCodeOf(item.result) : undefined;
		if (exit !== undefined) parts.push(`exit ${exit}`);
		if (item.name === "write" && isRecord(item.args) && typeof item.args.content === "string") parts.push(plural(item.args.content.split("\n").length, "line"));
		const duration = durationText(item);
		if (duration) parts.push(duration);
		const error = errorLine(item.result);
		const headline: ToolHeadline = { name, primary: relativeTo(primaryArg(item, kind), cwd), glyph, detail: parts.join(" · ") };
		return error ? { ...headline, error } : headline;
	} catch {
		return { name: item.name, primary: "", glyph, detail: "" };
	}
}

// ── DOM rendering ────────────────────────────────────────────────────────────

export interface ToolRenderContext extends OpenState {
	post(message: WebviewMessage): void;
	/** OMP working directory; paths under it render relative in collapsed rows. */
	cwd?: string;
}

const PREVIEW_LINES = 20;
const PREVIEW_CHARS = 4000;

/** Text block truncated to its tail/head with a "show more" toggle. */
function textBlock(ctx: ToolRenderContext, key: string, text: string, opts: { tail?: boolean; className?: string } = {}): HTMLElement {
	const pre = h("pre", { class: `out ${opts.className ?? ""}` });
	const lines = text.split("\n");
	const long = lines.length > PREVIEW_LINES || text.length > PREVIEW_CHARS;
	const expanded = ctx.isOpen(key) === true;
	if (!long || expanded) {
		pre.textContent = text;
		return pre;
	}
	const shown = opts.tail ? lines.slice(-PREVIEW_LINES).join("\n") : lines.slice(0, PREVIEW_LINES).join("\n");
	pre.textContent = shown.length > PREVIEW_CHARS ? (opts.tail ? shown.slice(-PREVIEW_CHARS) : shown.slice(0, PREVIEW_CHARS)) : shown;
	const more = h("button", {
		class: "link more",
		onClick: () => {
			ctx.setOpen(key, true);
			pre.textContent = text;
			more.remove();
		},
	}, `show more (${lines.length} lines)`);
	const wrap = h("div", undefined, pre, more);
	if (opts.tail) wrap.prepend(more);
	return wrap;
}

function argsSection(ctx: ToolRenderContext, item: ToolItem): HTMLElement {
	return collapsible(ctx, `${item.id}:args`, ["args"], () => textBlock(ctx, `${item.id}:args:more`, JSON.stringify(item.args ?? null, null, 2)));
}

/** Output of an expanded tool; open by default since expanding the row already asked for detail. */
function outputSection(ctx: ToolRenderContext, item: ToolItem, label = "output", tail = false): HTMLElement | undefined {
	const text = item.result?.text ?? item.partial;
	if (!text) return undefined;
	const lineCount = text.split("\n").length;
	return collapsible(
		ctx,
		`${item.id}:out`,
		[`${label} (${plural(lineCount, "line")})`],
		() => textBlock(ctx, `${item.id}:out:more`, text, { tail, className: item.result?.isError ? "error" : "" }),
		true,
	);
}

function actionsLine(...children: Child[]): HTMLElement | null {
	return children.some(Boolean) ? h("div", { class: "tool-actions" }, ...children) : null;
}

function fileLink(ctx: ToolRenderContext, path: string, line?: number): HTMLElement {
	return h(
		"button",
		{ class: "link path", title: `Open ${line ? `${path}:${line}` : path}`, onClick: () => ctx.post({ type: "openFile", path, line }) },
		line ? `${path}:${line}` : path,
	);
}

function genericBody(item: ToolItem, ctx: ToolRenderContext): Child[] {
	return [argsSection(ctx, item), outputSection(ctx, item)];
}

/** `path:12` / `path:12-40` read selectors → path + first line. */
function splitSelector(raw: string): { path: string; line?: number } {
	const match = /^(.*[^:]):(\d+)(?:[-+]\d*)?$/.exec(raw);
	return match ? { path: match[1], line: Number(match[2]) } : { path: raw };
}

function diffSection(ctx: ToolRenderContext, item: ToolItem, diff: string): HTMLElement {
	const lines = diff.replace(/\n$/, "").split("\n");
	return collapsible(
		ctx,
		`${item.id}:diff`,
		[`diff (${lines.length} lines)`],
		() => h("pre", { class: "diff" }, ...lines.map(line => h("div", { class: `d-${diffLineClass(line)}` }, line || " "))),
		lines.length <= 60,
	);
}

function collectDiff(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	if (Array.isArray(details.perFileResults)) {
		const diffs = details.perFileResults.flatMap(entry => (isRecord(entry) && str(entry.diff) ? [`--- ${str(entry.path) ?? ""}`, str(entry.diff) as string] : []));
		if (diffs.length > 0) return diffs.join("\n");
	}
	return str(details.diff);
}

function fileBody(item: ToolItem, ctx: ToolRenderContext): Child[] {
	const args = isRecord(item.args) ? item.args : {};
	const details = isRecord(item.result?.details) ? item.result.details : {};
	const raw = str(args.path) ?? str(args.file) ?? str(details.path) ?? str(details.resolvedPath);
	const target = raw ? splitSelector(raw) : undefined;
	const line = num(details.firstChangedLine) ?? num(args.line) ?? num(args.offset) ?? target?.line;
	const diff = collectDiff(item.result?.details);
	const canDiff = (diff || item.name === "write" || item.name === "edit" || item.name === "ast_edit") && item.status !== "running";
	const body: Child[] = [
		actionsLine(
			target ? fileLink(ctx, target.path, line) : null,
			canDiff ? h("button", { class: "link", title: "Open native diff", onClick: () => ctx.post({ type: "openDiff", toolCallId: item.id }) }, "Diff") : null,
		),
	];
	if (diff) body.push(diffSection(ctx, item, diff));
	if (item.name !== "read" && !diff) body.push(argsSection(ctx, item));
	if (item.name === "read" || item.result?.isError || !diff) body.push(outputSection(ctx, item));
	return body;
}

function searchBody(item: ToolItem, ctx: ToolRenderContext): Child[] {
	return [outputSection(ctx, item, "results")];
}

function shellBody(item: ToolItem, ctx: ToolRenderContext): Child[] {
	const command = shellCommand(item);
	const output = item.result?.text ?? item.partial ?? "";
	const body: Child[] = [];
	if (command.includes("\n") || command.length > MAX_SUMMARY) {
		body.push(collapsible(ctx, `${item.id}:cmd`, ["command"], () => h("pre", { class: "out" }, command)));
	}
	if (output) {
		body.push(item.status === "running" ? textBlock(ctx, `${item.id}:out:more`, output, { tail: true }) : outputSection(ctx, item, "output", true));
	}
	return body;
}

function taskBody(item: ToolItem, ctx: ToolRenderContext): Child[] {
	const args = isRecord(item.args) ? item.args : {};
	const names = Array.isArray(args.tasks) ? taskNames(args.tasks) : [];
	const showAgents = () => ctx.post({ type: "showAgents" });
	return [
		actionsLine(h("button", { class: "link", onClick: showAgents }, "Agents")),
		names.length > 0 ? h("ul", { class: "task-list" }, ...names.map(name => h("li", undefined, h("button", { class: "link", onClick: showAgents }, name)))) : null,
		outputSection(ctx, item),
	];
}

function lspBody(item: ToolItem, ctx: ToolRenderContext): Child[] {
	const args = isRecord(item.args) ? item.args : {};
	const file = str(args.file) ?? str(args.path);
	return [actionsLine(file ? fileLink(ctx, file, num(args.line)) : null), argsSection(ctx, item), outputSection(ctx, item)];
}

function mcpBody(item: ToolItem, ctx: ToolRenderContext): Child[] {
	return [h("div", { class: "meta" }, item.name), ...genericBody(item, ctx)];
}

const BODIES: Record<RendererKind, (item: ToolItem, ctx: ToolRenderContext) => Child[]> = {
	file: fileBody,
	search: searchBody,
	shell: shellBody,
	task: taskBody,
	lsp: lspBody,
	mcp: mcpBody,
	job: genericBody,
	generic: genericBody,
};

/**
 * One-line collapsed row (`▸ read  src/a.ts  ✓ 12ms`); expanding builds the specialized body,
 * falling back to the generic body when the specialized renderer throws.
 */
export function renderTool(item: ToolItem, ctx: ToolRenderContext): HTMLElement {
	const head = toolHeadline(item, ctx.cwd);
	const state = item.status === "running" ? "running" : head.glyph === "✗" ? "error" : "done";
	const build = () => {
		try {
			return BODIES[pickRenderer(item.name)](item, ctx);
		} catch {
			return genericBody(item, ctx);
		}
	};
	const row = collapsible(
		ctx,
		item.id,
		[
			h("span", { class: "tool-name", title: item.name }, head.name),
			h("span", { class: "tool-primary", title: head.primary }, head.primary),
			h("span", { class: "tool-glyph", title: item.status }, head.glyph),
			head.detail ? h("span", { class: "tool-detail" }, head.detail) : null,
		],
		() => h("div", { class: "tool-body" }, ...build()),
	);
	return h(
		"div",
		{ class: `tool status-${state}`, attrs: { "data-tool": item.name } },
		row,
		head.error ? h("div", { class: "tool-error", title: head.error }, head.error) : null,
	);
}
