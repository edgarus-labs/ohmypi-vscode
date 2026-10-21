import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

export const DOC_SCHEME = "omp-doc";
const MAX_DOCS = 20;
/** Total text kept for generated documents. */
const MAX_DOC_CHARS = 32 * 1024 * 1024;

/** Read-only generated documents (agent summaries, transcripts) under `omp-doc:`. */
export class VirtualDocuments implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	/** Keeps uris of this instance apart from those of an earlier activation still open in the window. */
	private readonly instance = randomUUID();
	private sequence = 0;
	private retainedChars = 0;

	/** Keeps the newest {@link MAX_DOCS} documents and drops the oldest while their text exceeds `maxChars`, always keeping the newest. */
	constructor(private readonly maxChars = MAX_DOC_CHARS) {}

	/** Throws when the content is no longer kept, so VS Code shows an error instead of an empty document. */
	provideTextDocumentContent(uri: vscode.Uri): string {
		const content = this.contents.get(uri.toString());
		if (content === undefined) throw new Error("This OMP document is no longer available; open it again from where it was shown.");
		return content;
	}

	/** `name` should carry the extension that selects the language, e.g. `agent.md`. */
	async show(name: string, content: string): Promise<void> {
		const uri = vscode.Uri.from({ scheme: DOC_SCHEME, path: `/${name.replace(/[\\/]/g, "_")}`, query: `${this.instance}-${++this.sequence}` });
		this.contents.set(uri.toString(), content);
		this.retainedChars += content.length;
		for (const [key, kept] of this.contents) {
			if (this.contents.size <= 1 || (this.contents.size <= MAX_DOCS && this.retainedChars <= this.maxChars)) break;
			this.contents.delete(key);
			this.retainedChars -= kept.length;
		}
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document, { preview: true });
	}
}
