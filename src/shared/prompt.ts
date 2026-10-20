/**
 * Wire format of a user prompt: `formatPrompt` writes it (host, before sending to OMP) and
 * `splitUserMessage` reads it back (webview, to render the user's message as chips).
 *
 * Layout, parts separated by a blank line: optional `<editor-context>…</editor-context>` block,
 * the typed text, one `<pasted-text name="…">` block per pasted text, then `Attached: @a @"b c" @"d\"e"`
 * (a mention is quoted when it contains whitespace, `"` or `@`; quotes inside it are escaped as `\"`).
 */
export interface PromptParts {
	/** Complete `<editor-context>` block. */
	editorContext?: string;
	text: string;
	pasted: Array<{ name: string; text: string }>;
	/** File paths as they should appear in the mention (relative to the working directory when inside it). */
	files: string[];
}

const EDITOR_CONTEXT_START = "<editor-context>";
const EDITOR_CONTEXT_END = "</editor-context>";
const PASTED_END = "</pasted-text>";
const PASTED_END_ESCAPED = "<\\/pasted-text>";
const PASTED_BLOCK = /\n*<pasted-text name="([^"]*)">\n([\s\S]*?)\n<\/pasted-text>/g;
const ATTACHED_LINE = /\n*Attached: ((?:@(?:"(?:\\"|[^"])+"|\S+) ?)+)$/;
const MENTION = /@(?:"((?:\\"|[^"])+)"|(\S+))/g;

export function formatPrompt({ editorContext, text, pasted, files }: PromptParts): string {
	const parts: string[] = [];
	if (editorContext) parts.push(editorContext);
	if (text) parts.push(text);
	for (const block of pasted) {
		parts.push(`<pasted-text name="${block.name.replaceAll('"', "'")}">\n${block.text.replaceAll(PASTED_END, PASTED_END_ESCAPED)}\n${PASTED_END}`);
	}
	if (files.length > 0) parts.push(`Attached: ${files.map(file => (/[\s"@]/.test(file) ? `@"${file.replaceAll('"', '\\"')}"` : `@${file}`)).join(" ")}`);
	return parts.join("\n\n");
}

export function splitUserMessage(message: string): PromptParts {
	let rest = message;
	let editorContext: string | undefined;
	const end = rest.indexOf(EDITOR_CONTEXT_END);
	if (rest.startsWith(EDITOR_CONTEXT_START) && end >= 0) {
		editorContext = rest.slice(0, end + EDITOR_CONTEXT_END.length);
		rest = rest.slice(end + EDITOR_CONTEXT_END.length).replace(/^\n+/, "");
	}
	const files: string[] = [];
	const attached = ATTACHED_LINE.exec(rest);
	if (attached && (attached.index === 0 || rest[attached.index] === "\n")) {
		for (const mention of attached[1].matchAll(MENTION)) files.push(mention[1]?.replaceAll('\\"', '"') ?? mention[2]);
		rest = rest.slice(0, attached.index);
	}
	const pasted: PromptParts["pasted"] = [];
	rest = rest.replace(PASTED_BLOCK, (_block, name: string, body: string) => {
		pasted.push({ name, text: body.replaceAll(PASTED_END_ESCAPED, PASTED_END) });
		return "";
	});
	return { text: rest.trim(), ...(editorContext ? { editorContext } : {}), pasted, files };
}
