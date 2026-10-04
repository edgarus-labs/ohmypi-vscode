import { fenceFor } from "../ui/format";

export interface EditorContextData {
	workspaceFolders: string[];
	activeFile?: { path: string; languageId: string; line: number; column: number };
	selection?: { text: string; startLine: number; endLine: number };
	openEditors: string[];
	diagnostics: Array<{ severity: "error" | "warning"; line: number; message: string; source?: string }>;
	workspaceDiagnostics: { errors: number; warnings: number };
	gitChanges?: string[];
}

export const MAX_SELECTION_CHARS = 8192;
const MAX_OPEN_EDITORS = 10;
const MAX_DIAGNOSTICS = 20;
const MAX_GIT_CHANGES = 30;

function listWithOverflow(items: string[], max: number): string {
	const shown = items.slice(0, max).join(", ");
	return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

export function formatEditorContext(data: EditorContextData): string {
	const out = ["<editor-context>"];
	if (data.workspaceFolders.length > 0) out.push(`workspace: ${data.workspaceFolders.join(", ")}`);
	const active = data.activeFile;
	if (active) out.push(`active file: ${active.path} (${active.languageId}), cursor ${active.line}:${active.column}`);
	if (data.selection && data.selection.text) {
		const { text, startLine, endLine } = data.selection;
		const truncated = text.length > MAX_SELECTION_CHARS;
		const body = truncated ? `${text.slice(0, MAX_SELECTION_CHARS)}\n[selection truncated]` : text;
		const fence = fenceFor(body);
		out.push(`selection (lines ${startLine}-${endLine}):`, `${fence}${active?.languageId ?? ""}`, body, fence);
	}
	if (data.openEditors.length > 0) out.push(`open editors: ${listWithOverflow(data.openEditors, MAX_OPEN_EDITORS)}`);
	if (data.diagnostics.length > 0) {
		out.push("diagnostics in active file:");
		for (const diagnostic of data.diagnostics.slice(0, MAX_DIAGNOSTICS)) {
			const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
			out.push(`- ${diagnostic.severity} L${diagnostic.line}: ${diagnostic.message.replace(/\s*\n\s*/g, " ")}${source}`);
		}
		if (data.diagnostics.length > MAX_DIAGNOSTICS) out.push(`(+${data.diagnostics.length - MAX_DIAGNOSTICS} more diagnostics)`);
	}
	const { errors, warnings } = data.workspaceDiagnostics;
	if (errors > 0 || warnings > 0) out.push(`workspace diagnostics: ${errors} errors, ${warnings} warnings`);
	if (data.gitChanges && data.gitChanges.length > 0) out.push(`git changes: ${listWithOverflow(data.gitChanges, MAX_GIT_CHANGES)}`);
	out.push("</editor-context>");
	return out.join("\n");
}
