/**
 * Wire format of a user prompt: `formatPrompt` writes it (host, before sending to OMP) and
 * `splitUserMessage` reads it back (webview, to render the user's message as chips).
 *
 * Layout, parts separated by a blank line: optional `<editor-context>…</editor-context>` block,
 * the typed text, one `<pasted-text name="…">` block per pasted text, then a last line
 * `Attached: @a @"b c" @"d\"e"` (mentions separated by one space; a mention is quoted when it contains
 * whitespace, `"` or `@`; quotes inside it are escaped as `\"`). A closing tag of the editor context or of a
 * pasted block inside that block (in any letter case, with or without space before `>`) gets one more
 * backslash before its `/`: `</pasted-text>` is written as `<\/pasted-text>`, `<\/pasted-text>` as `<\\/pasted-text>`.
 */
export interface PromptParts {
	/** Complete `<editor-context>` block. */
	editorContext?: string;
	text: string;
	pasted: Array<{ name: string; text: string }>;
	/** File paths as they should appear in the mention (relative to the working directory when inside it). */
	files: string[];
}

const EDITOR_CONTEXT_TAG = "editor-context";
const EDITOR_CONTEXT_START = `<${EDITOR_CONTEXT_TAG}>`;
const EDITOR_CONTEXT_END = `</${EDITOR_CONTEXT_TAG}>`;
const PASTED_TAG = "pasted-text";
const PASTED_END = `</${PASTED_TAG}>`;
const PASTED_BLOCK = /\n*<pasted-text name="([^"]*)">\n([\s\S]*?)\n<\/pasted-text>/g;
const MENTION_SOURCE = String.raw`@(?:"(?:\\.|[^"\\])+"|[^\s"]\S*)`;
const ATTACHED_LINE = new RegExp(String.raw`^Attached: (${MENTION_SOURCE}(?: ${MENTION_SOURCE})*)$`);
const MENTION = /@(?:"((?:\\.|[^"\\])+)"|([^\s"]\S*))/g;

/** Inserts a backslash before the `/` of every `</tag>`, `<\/tag>`, `<\\/tag>`… in any letter case, so the text holds no closing `tag`. */
function escapeClosingTag(text: string, tag: string): string {
	return text.replace(new RegExp(String.raw`<(\\*)/(${tag}\s*)>`, "gi"), (_match, slashes: string, name: string) => `<${slashes}\\/${name}>`);
}

/** Undoes {@link escapeClosingTag}. */
function unescapeClosingTag(text: string, tag: string): string {
	return text.replace(new RegExp(String.raw`<(\\*)\\/(${tag}\s*)>`, "gi"), (_match, slashes: string, name: string) => `<${slashes}/${name}>`);
}

/** `block` with any closing tag between its own start and end tags escaped. */
function escapeEditorContext(block: string): string {
	if (!block.startsWith(EDITOR_CONTEXT_START) || !block.endsWith(EDITOR_CONTEXT_END)) return block;
	const inner = block.slice(EDITOR_CONTEXT_START.length, block.length - EDITOR_CONTEXT_END.length);
	return `${EDITOR_CONTEXT_START}${escapeClosingTag(inner, EDITOR_CONTEXT_TAG)}${EDITOR_CONTEXT_END}`;
}

export function formatPrompt({ editorContext, text, pasted, files }: PromptParts): string {
	const parts: string[] = [];
	if (editorContext) parts.push(escapeEditorContext(editorContext));
	if (text) parts.push(text);
	for (const block of pasted) {
		parts.push(`<pasted-text name="${block.name.replaceAll('"', "'")}">\n${escapeClosingTag(block.text, PASTED_TAG)}\n${PASTED_END}`);
	}
	if (files.length > 0) parts.push(`Attached: ${files.map(file => (/[\s"@]/.test(file) ? `@"${file.replaceAll('"', '\\"')}"` : `@${file}`)).join(" ")}`);
	return parts.join("\n\n");
}

export function splitUserMessage(message: string): PromptParts {
	let rest = message;
	let editorContext: string | undefined;
	const end = rest.indexOf(EDITOR_CONTEXT_END);
	if (rest.startsWith(EDITOR_CONTEXT_START) && end >= 0) {
		editorContext = `${EDITOR_CONTEXT_START}${unescapeClosingTag(rest.slice(EDITOR_CONTEXT_START.length, end), EDITOR_CONTEXT_TAG)}${EDITOR_CONTEXT_END}`;
		rest = rest.slice(end + EDITOR_CONTEXT_END.length).replace(/^\n+/, "");
	}
	const files: string[] = [];
	const lastLineStart = rest.lastIndexOf("\n") + 1;
	const attached = ATTACHED_LINE.exec(rest.slice(lastLineStart));
	if (attached) {
		for (const mention of attached[1].matchAll(MENTION)) files.push(mention[1]?.replaceAll('\\"', '"') ?? mention[2]);
		rest = rest.slice(0, lastLineStart);
	}
	const pasted: PromptParts["pasted"] = [];
	rest = rest.replace(PASTED_BLOCK, (_block, name: string, body: string) => {
		pasted.push({ name, text: unescapeClosingTag(body, PASTED_TAG) });
		return "";
	});
	return { text: rest.trim(), ...(editorContext ? { editorContext } : {}), pasted, files };
}
