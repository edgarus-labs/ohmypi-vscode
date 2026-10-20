import * as vscode from "vscode";
import type { Logger } from "../omp/api";
import { deferred } from "../shared/deferred";
import { errorMessage } from "../shared/errors";

const WORKSPACE_FILE_LIMIT = 5000;
const WORKSPACE_EXCLUDE = "**/{node_modules,.git}/**";

interface FileItem extends vscode.QuickPickItem {
	uri?: vscode.Uri;
}

function fileItem(uri: vscode.Uri): FileItem {
	const relative = vscode.workspace.asRelativePath(uri, false);
	const slash = relative.lastIndexOf("/");
	return {
		label: relative.slice(slash + 1),
		description: slash > 0 ? relative.slice(0, slash) : undefined,
		iconPath: vscode.ThemeIcon.File,
		resourceUri: uri,
		uri,
	} as FileItem;
}

/** Open text editors, the active one first, without duplicates. */
function openEditorUris(): vscode.Uri[] {
	const active = vscode.window.activeTextEditor?.document.uri;
	const uris = vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.flatMap(tab => (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "file" ? [tab.input.uri] : []));
	if (active?.scheme === "file") uris.unshift(active);
	const seen = new Set<string>();
	return uris.filter(uri => !seen.has(uri.toString()) && seen.add(uri.toString()));
}

/** Multi-select picker over open editors and workspace files; resolves to the chosen files (empty when dismissed). */
export function pickContextFiles(logger: Logger): Promise<vscode.Uri[]> {
	const { promise, resolve } = deferred<vscode.Uri[]>();
	const picker = vscode.window.createQuickPick<FileItem>();
	picker.title = "Add files to the OMP chat";
	picker.placeholder = "Search files; select several with Space, confirm with Enter";
	picker.canSelectMany = true;
	picker.matchOnDescription = true;
	const open = openEditorUris();
	const openItems: FileItem[] = open.length > 0 ? [{ label: "Open editors", kind: vscode.QuickPickItemKind.Separator }, ...open.map(fileItem)] : [];
	picker.items = openItems;
	picker.busy = true;
	const openKeys = new Set(open.map(uri => uri.toString()));
	vscode.workspace.findFiles("**/*", WORKSPACE_EXCLUDE, WORKSPACE_FILE_LIMIT).then(
		files => {
			const selected = picker.selectedItems;
			const rest = files
				.filter(uri => !openKeys.has(uri.toString()))
				.sort((a, b) => a.fsPath.localeCompare(b.fsPath))
				.map(fileItem);
			picker.items = [...openItems, { label: "Workspace", kind: vscode.QuickPickItemKind.Separator }, ...rest];
			picker.selectedItems = picker.items.filter(item => selected.some(chosen => chosen.uri?.toString() === item.uri?.toString()));
			picker.busy = false;
		},
		error => {
			logger.warn("Workspace file search failed", error);
			picker.title = `Add files to the OMP chat (workspace search failed: ${errorMessage(error)})`;
			picker.busy = false;
		},
	);
	picker.onDidAccept(() => {
		const chosen = picker.selectedItems.length > 0 ? picker.selectedItems : picker.activeItems;
		resolve(chosen.flatMap(item => (item.uri ? [item.uri] : [])));
		picker.hide();
	});
	picker.onDidHide(() => {
		resolve([]);
		picker.dispose();
	});
	picker.show();
	return promise;
}
