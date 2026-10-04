import * as vscode from "vscode";

export const DOC_SCHEME = "omp-doc";
const MAX_DOCS = 20;

/** Read-only generated documents (agent summaries, transcripts) under `omp-doc:`. */
export class VirtualDocuments implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private sequence = 0;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? "";
	}

	/** `name` should carry the extension that selects the language, e.g. `agent.md`. */
	async show(name: string, content: string): Promise<void> {
		const uri = vscode.Uri.from({ scheme: DOC_SCHEME, path: `/${name.replace(/[\\/]/g, "_")}`, query: String(++this.sequence) });
		this.contents.set(uri.toString(), content);
		if (this.contents.size > MAX_DOCS) this.contents.delete(this.contents.keys().next().value as string);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: true });
	}
}
