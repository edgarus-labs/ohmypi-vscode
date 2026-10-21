/** Turns VS Code state into the compact text the agent reads. */
import { truncateToolText } from "../../omp/hostTools";
import { resolveRange } from "./lineEdits";

/** A document whose lines can be listed; `lineAt` takes a 0-based line. */
export interface ListedDocument {
	path: string;
	totalLines: number;
	lineAt(line: number): string;
	fromEditor: boolean;
}

/** Lines `startLine`..`endLine` (1-based, default the whole document) numbered under a header naming the source. */
export function documentListing(document: ListedDocument, startLine?: number, endLine?: number): string {
	const { first, last } = resolveRange(document.totalLines, startLine, endLine);
	const width = String(last).length;
	const lines = [`${document.path} (lines ${first}-${last} of ${document.totalLines}, ${document.fromEditor ? "editor buffer" : "disk"})`];
	for (let line = first; line <= last; line++) lines.push(`${String(line).padStart(width)}: ${document.lineAt(line - 1)}`);
	return truncateToolText(lines.join("\n"), "; narrow the range with startLine/endLine");
}

export interface DocumentInfo {
	path: string;
	isActive: boolean;
	isDirty: boolean;
	isPreview: boolean;
}

export function documents(infos: readonly DocumentInfo[]): string {
	if (infos.length === 0) return "No documents are open.";
	return infos
		.map(info => info.path + (info.isActive ? " [active]" : "") + (info.isDirty ? " [unsaved]" : "") + (info.isPreview ? " [preview]" : ""))
		.join("\n");
}

export function opened(path: string, line: number | undefined, column: number | undefined): string {
	const where = line === undefined ? "" : column === undefined ? ` at line ${line}` : ` at line ${line}, column ${column}`;
	return `Opened ${path}${where}.`;
}

export function replaced(path: string, startLine: number, endLine: number): string {
	const what = endLine < startLine ? `Inserted text before line ${startLine}` : `Replaced lines ${startLine}-${endLine}`;
	return `${what} of ${path}. The document has unsaved changes; call vscode_save to write it.`;
}

export function saved(paths: readonly string[]): string {
	return paths.length === 0 ? "Nothing to save." : `Saved ${paths.length} document(s):\n${paths.join("\n")}`;
}

export interface SelectionInfo {
	path: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
	text: string;
}

export function selection(info: SelectionInfo | undefined): string {
	if (!info) return "No active text editor.";
	if (info.text.length === 0) return `${info.path} cursor at ${info.startLine}:${info.startColumn} (nothing selected)`;
	return `${info.path} ${info.startLine}:${info.startColumn}-${info.endLine}:${info.endColumn}\n${info.text}`;
}

export type Severity = "error" | "warning" | "info" | "hint";

export interface DiagnosticItem {
	severity: Severity;
	code?: string;
	path: string;
	/** 1-based. */
	line: number;
	/** 1-based. */
	column: number;
	message: string;
	source?: string;
}

function diagnostic(item: DiagnosticItem): string {
	const code = item.code ? ` ${item.code}` : "";
	const source = item.source ? ` (${item.source})` : "";
	return `${item.severity}${code} ${item.path}(${item.line},${item.column}): ${item.message}${source}`;
}

/** The first `max` diagnostics of `severity` (`all` lists every one). */
export function diagnostics(items: readonly DiagnosticItem[], severity: Severity | "all", max: number): string {
	const label = severity === "all" ? "item" : severity;
	const matching = severity === "all" ? items : items.filter(item => item.severity === severity);
	if (matching.length === 0) return `No ${label}s.`;
	const header = matching.length > max ? `Showing first ${max} of ${matching.length} ${label}(s):` : `${matching.length} ${label}(s):`;
	return [header, ...matching.slice(0, max).map(diagnostic)].join("\n");
}

const MAX_TASK_DIAGNOSTICS = 50;

/** How a task ended, followed by the errors and warnings the Problems panel shows afterwards. */
export function taskResult(label: string, exitCode: number | undefined, items: readonly DiagnosticItem[]): string {
	const errors = items.filter(item => item.severity === "error");
	const warnings = items.filter(item => item.severity === "warning");
	const listed = [...errors, ...warnings];
	const lines = [
		exitCode === undefined ? `Task ${label} finished.` : `Task ${label} finished with exit code ${exitCode}.`,
		`Problems: ${errors.length} error(s), ${warnings.length} warning(s).`,
		...listed.slice(0, MAX_TASK_DIAGNOSTICS).map(diagnostic),
	];
	if (listed.length > MAX_TASK_DIAGNOSTICS) lines.push(`… ${listed.length - MAX_TASK_DIAGNOSTICS} more; use vscode_diagnostics to list them.`);
	return lines.join("\n");
}

export interface TaskInfo {
	label: string;
	group?: string;
	isBackground: boolean;
}

export function tasks(infos: readonly TaskInfo[]): string {
	if (infos.length === 0) return "No tasks are available.";
	return infos.map(info => info.label + (info.group ? ` [${info.group}]` : "") + (info.isBackground ? " [background]" : "")).join("\n");
}

export interface BreakpointInfo {
	/** `path:line` of a source breakpoint, `function <name>` of a function breakpoint. */
	location: string;
	condition?: string;
	enabled: boolean;
}

export function breakpoints(infos: readonly BreakpointInfo[]): string {
	if (infos.length === 0) return "No breakpoints.";
	return infos.map(info => info.location + (info.condition ? ` [condition: ${info.condition}]` : "") + (info.enabled ? "" : " [disabled]")).join("\n");
}

export function breakpointsRemoved(removed: number, path: string, line: number | undefined): string {
	return line === undefined ? `Removed ${removed} breakpoint(s) in ${path}.` : `Removed ${removed} breakpoint(s) at ${path}:${line}.`;
}

export interface StoppedState {
	session: string;
	reason: string;
	location?: string;
	exception?: string;
}

export function stoppedDebugger(state: StoppedState): string {
	const lines = [`Debugger: stopped (${state.reason}) in ${state.session}`];
	if (state.location) lines.push(`Location: ${state.location}`);
	if (state.exception) lines.push(`Exception: ${state.exception}`);
	return lines.join("\n");
}

export function callStack(frames: readonly string[]): string {
	return frames.length === 0 ? "No stack frames." : frames.map((frame, index) => `${index}: ${frame}`).join("\n");
}

export interface VariableInfo {
	name: string;
	type?: string;
	value: string;
}

export function locals(variables: readonly VariableInfo[]): string {
	if (variables.length === 0) return "No local variables.";
	return variables.map(variable => `${variable.name + (variable.type ? ` (${variable.type})` : "")} = ${variable.value}`).join("\n");
}
