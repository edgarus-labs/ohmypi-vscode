import * as vscode from "vscode";
import { isWithinRoots, resolveToolPath } from "./changePaths";

/** OMP's working directory and every workspace folder: where tool paths are trusted. */
export function workspaceRoots(cwd: string): string[] {
	return [cwd, ...(vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)];
}

/**
 * Whether a path taken from OMP's tool output may be opened: true inside the workspace,
 * otherwise only after the user confirms (opening reads the file, and a UNC path reaches the network).
 */
export async function confirmToolFile(filePath: string, cwd: string): Promise<boolean> {
	if (isWithinRoots(filePath, workspaceRoots(cwd))) return true;
	const choice = await vscode.window.showWarningMessage(
		`${filePath} is outside the workspace. Open it anyway?`,
		{ modal: true, detail: "The path comes from OMP's tool output." },
		"Open",
	);
	return choice === "Open";
}

/** Whether `filePath` exists; failures other than a missing file are rethrown. */
export async function exists(filePath: string): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
		return true;
	} catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return false;
		throw error;
	}
}

/**
 * The workspace file a bare file name (no directory part, no glob characters) stands for: the only match,
 * or the user's pick among several; `undefined` when the user dismisses the pick.
 */
async function findByName(name: string): Promise<vscode.Uri | undefined> {
	const matches = /[*?[\]{}]/.test(name) ? [] : await vscode.workspace.findFiles(`**/${name}`, "**/{node_modules,.git}/**", 20);
	if (matches.length === 0) throw new Error(`File not found: ${name}`);
	if (matches.length === 1) return matches[0];
	const picked = await vscode.window.showQuickPick(
		matches.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })),
		{ placeHolder: `Several files are named ${name}; choose one to open` },
	);
	return picked?.uri;
}

/**
 * Opens a path named by OMP (tool output or a reply), relative to `cwd`, optionally at a 1-based line.
 * A path outside the workspace is confirmed before it is touched at all; a missing bare file name
 * (no directory part) is looked up in the workspace.
 */
export async function openToolFile(rawPath: string, line: number | undefined, cwd: string): Promise<void> {
	const resolved = resolveToolPath(rawPath, cwd);
	if (!resolved) throw new Error(`Not a local file: ${rawPath}`);
	if (!(await confirmToolFile(resolved, cwd))) return;
	let filePath = resolved;
	if (!(await exists(resolved))) {
		if (/[\\/]/.test(rawPath)) throw new Error(`File not found: ${rawPath}`);
		const found = await findByName(rawPath.trim());
		if (!found || !(await confirmToolFile(found.fsPath, cwd))) return;
		filePath = found.fsPath;
	}
	const position = line && line > 0 ? new vscode.Position(line - 1, 0) : undefined;
	await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
		preview: true,
		selection: position && new vscode.Range(position, position),
	});
}
