import * as path from "node:path";
import type { PromptImage } from "../omp/api";
import type { Attachment } from "../webview/protocol";

export interface ComposeInput {
	text: string;
	attachments: readonly Attachment[];
	cwd: string;
	/** `<editor-context>` block placed before everything else. */
	editorContext?: string;
}

/** Inside the working directory relative to it, otherwise absolute; quoted when OMP's mention syntax requires it. */
function fileMention(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	const shown = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
	return /[\s"@]/.test(shown) ? `@"${shown}"` : `@${shown}`;
}

/**
 * Builds the OMP prompt for the user's text and attachments. Files become `@path`
 * mentions, which OMP reads itself; pasted text becomes `<pasted-text>` blocks;
 * images travel in the RPC `images` field.
 */
export function composePrompt({ text, attachments, cwd, editorContext }: ComposeInput): { message: string; images: PromptImage[] } {
	const parts: string[] = [];
	if (editorContext) parts.push(editorContext);
	if (text) parts.push(text);
	for (const attachment of attachments) {
		if (attachment.kind !== "text") continue;
		const body = attachment.text.replaceAll("</pasted-text>", "<\\/pasted-text>");
		parts.push(`<pasted-text name="${attachment.label.replaceAll('"', "'")}">\n${body}\n</pasted-text>`);
	}
	const files = attachments.flatMap(attachment => (attachment.kind === "file" ? [fileMention(attachment.path, cwd)] : []));
	if (files.length > 0) parts.push(`Attached: ${files.join(" ")}`);
	const images = attachments.flatMap(attachment => (attachment.kind === "image" ? [{ data: attachment.data, mimeType: attachment.mimeType }] : []));
	return { message: parts.join("\n\n"), images };
}
