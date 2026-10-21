import * as path from "node:path";
import type { PromptImage } from "../omp/api";
import { formatPrompt } from "../shared/prompt";
import type { Attachment } from "../webview/protocol";

export interface ComposeInput {
	text: string;
	attachments: readonly Attachment[];
	cwd: string;
	/** `<editor-context>` block placed before everything else. */
	editorContext?: string;
}

/** Inside the working directory relative to it, otherwise absolute. */
function mentionPath(filePath: string, cwd: string): string {
	const relative = path.relative(cwd, filePath);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

/**
 * Builds the OMP prompt for the user's text and attachments. Files become `@path`
 * mentions, which OMP reads itself; pasted text becomes `<pasted-text>` blocks;
 * images travel in the RPC `images` field.
 */
export function composePrompt({ text, attachments, cwd, editorContext }: ComposeInput): { message: string; images: PromptImage[] } {
	const message = formatPrompt({
		editorContext,
		text,
		pasted: attachments.flatMap(attachment => (attachment.kind === "text" ? [{ name: attachment.label, text: attachment.text }] : [])),
		files: attachments.flatMap(attachment => (attachment.kind === "file" ? [mentionPath(attachment.path, cwd)] : [])),
	});
	const images = attachments.flatMap(attachment => (attachment.kind === "image" ? [{ data: attachment.data, mimeType: attachment.mimeType }] : []));
	return { message, images };
}
