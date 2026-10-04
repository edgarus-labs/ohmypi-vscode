import * as vscode from "vscode";
import type { Logger } from "../omp/api";
import { errorMessage } from "../ui/guards";
import { type EditorContextData, formatEditorContext, MAX_SELECTION_CHARS } from "./editorContextFormat";

interface GitRepositoryLike {
	state: { workingTreeChanges: Array<{ uri: vscode.Uri }>; indexChanges: Array<{ uri: vscode.Uri }> };
}

function gitChanges(logger: Logger): string[] | undefined {
	try {
		const extension = vscode.extensions.getExtension<{ getAPI(version: 1): { repositories: GitRepositoryLike[] } }>("vscode.git");
		if (!extension?.isActive) return undefined;
		const files = new Set<string>();
		for (const repository of extension.exports.getAPI(1).repositories) {
			for (const change of [...repository.state.indexChanges, ...repository.state.workingTreeChanges]) {
				files.add(vscode.workspace.asRelativePath(change.uri));
			}
		}
		return [...files];
	} catch (error) {
		logger.debug(`Git changes unavailable for editor context: ${errorMessage(error)}`);
		return undefined;
	}
}

/** Collects the editor state attached to prompts. Reads no file contents except the selection. */
export function gatherEditorContext(logger: Logger): EditorContextData {
	const editor = vscode.window.activeTextEditor;
	const activeUri = editor?.document.uri.toString();
	const data: EditorContextData = {
		workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath),
		openEditors: [],
		diagnostics: [],
		workspaceDiagnostics: { errors: 0, warnings: 0 },
		gitChanges: gitChanges(logger),
	};
	if (editor) {
		const { document, selection } = editor;
		data.activeFile = {
			path: vscode.workspace.asRelativePath(document.uri),
			languageId: document.languageId,
			line: selection.active.line + 1,
			column: selection.active.character + 1,
		};
		if (!selection.isEmpty) {
			const range = new vscode.Range(selection.start, document.positionAt(Math.min(document.offsetAt(selection.end), document.offsetAt(selection.start) + MAX_SELECTION_CHARS + 1)));
			data.selection = { text: document.getText(range), startLine: selection.start.line + 1, endLine: selection.end.line + 1 };
		}
	}
	const seen = new Set<string>();
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (!(tab.input instanceof vscode.TabInputText)) continue;
			const uri = tab.input.uri;
			if (uri.toString() === activeUri || seen.has(uri.toString())) continue;
			seen.add(uri.toString());
			data.openEditors.push(vscode.workspace.asRelativePath(uri));
		}
	}
	for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
		for (const diagnostic of diagnostics) {
			const severity =
				diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : diagnostic.severity === vscode.DiagnosticSeverity.Warning ? "warning" : undefined;
			if (!severity) continue;
			if (severity === "error") data.workspaceDiagnostics.errors++;
			else data.workspaceDiagnostics.warnings++;
			if (uri.toString() === activeUri) {
				data.diagnostics.push({ severity, line: diagnostic.range.start.line + 1, message: diagnostic.message, source: diagnostic.source });
			}
		}
	}
	return data;
}

export function editorContextBlock(logger: Logger): string {
	return formatEditorContext(gatherEditorContext(logger));
}
