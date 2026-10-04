import * as vscode from "vscode";

export const BASELINE_SCHEME = "omp-base";
/** Query marking an always-empty side (created or deleted file). */
export const EMPTY_QUERY = "empty";
const MAX_PINNED = 20;

export function baselineUri(filePath: string, query = ""): vscode.Uri {
	return vscode.Uri.file(filePath).with({ scheme: BASELINE_SCHEME, query });
}

/**
 * Read-only `omp-base:` documents: the change tracker's first-seen baseline for a path,
 * or content pinned for one diff (e.g. a tool's `oldText` from a loaded transcript).
 */
export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
	private readonly pinned = new Map<string, string>();
	private sequence = 0;

	constructor(
		private readonly baseline: (filePath: string) => string | undefined,
		readonly onDidChange: vscode.Event<vscode.Uri>,
	) {}

	pin(filePath: string, content: string): vscode.Uri {
		const key = `pin-${++this.sequence}`;
		this.pinned.set(key, content);
		if (this.pinned.size > MAX_PINNED) this.pinned.delete(this.pinned.keys().next().value as string);
		return baselineUri(filePath, key);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		if (uri.query === EMPTY_QUERY) return "";
		if (uri.query) return this.pinned.get(uri.query) ?? "";
		return this.baseline(uri.with({ scheme: "file", query: "" }).fsPath) ?? "";
	}
}
