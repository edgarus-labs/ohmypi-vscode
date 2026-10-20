import * as vscode from "vscode";

export const DOC_SCHEME = "omp-doc";
const MAX_DOCS = 20;

/** Read-only generated documents (agent summaries, transcripts) under `omp-doc:`. */
export class VirtualDocuments implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private sequence = 0;

	/** Throws when the content is no longer kept, so VS Code shows an error instead of an empty document. */
	provideTextDocumentContent(uri: vscode.Uri): string {
		const content = this.contents.get(uri.toString());
		if (content === undefined) throw new Error("This OMP document is no longer available; open it again from where it was shown.");
		return content;
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
