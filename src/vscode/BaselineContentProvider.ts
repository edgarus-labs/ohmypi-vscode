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
		/** First-seen content of a file; `null` when it did not exist, `undefined` when not kept. */
		private readonly baseline: (filePath: string) => string | null | undefined,
		readonly onDidChange: vscode.Event<vscode.Uri>,
	) {}

	pin(filePath: string, content: string): vscode.Uri {
		const key = `pin-${++this.sequence}`;
		this.pinned.set(key, content);
		if (this.pinned.size > MAX_PINNED) this.pinned.delete(this.pinned.keys().next().value as string);
		return baselineUri(filePath, key);
	}

	/** Throws when the content is no longer kept, so VS Code shows an error instead of a misleading diff. */
	provideTextDocumentContent(uri: vscode.Uri): string {
		if (uri.query === EMPTY_QUERY) return "";
		const filePath = uri.with({ scheme: "file", query: "" }).fsPath;
		const content = uri.query ? this.pinned.get(uri.query) : this.baseline(filePath);
		if (content === undefined) throw new Error(`The OMP baseline of ${filePath} is no longer available; open the diff again from the chat or the Changes view.`);
		return content ?? "";
	}
}
