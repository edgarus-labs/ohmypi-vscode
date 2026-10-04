/** A user prompt split back into the parts `composePrompt` assembled. */
export interface SplitUserMessage {
	text: string;
	editorContext?: string;
	pasted: Array<{ name: string; text: string }>;
	/** Mentioned paths as written in the prompt (relative to the working directory when inside it). */
	files: string[];
}

const EDITOR_CONTEXT_START = "<editor-context>";
const EDITOR_CONTEXT_END = "</editor-context>";
const PASTED_BLOCK = /\n*<pasted-text name="([^"]*)">\n([\s\S]*?)\n<\/pasted-text>/g;
const ATTACHED_LINE = /\n*Attached: ((?:@(?:"[^"]+"|\S+) ?)+)$/;
const MENTION = /@(?:"([^"]+)"|(\S+))/g;

export function splitUserMessage(message: string): SplitUserMessage {
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
		for (const mention of attached[1].matchAll(MENTION)) files.push(mention[1] ?? mention[2]);
		rest = rest.slice(0, attached.index);
	}
	const pasted: SplitUserMessage["pasted"] = [];
	rest = rest.replace(PASTED_BLOCK, (_block, name: string, body: string) => {
		pasted.push({ name, text: body.replaceAll("<\\/pasted-text>", "</pasted-text>") });
		return "";
	});
	return { text: rest.trim(), ...(editorContext ? { editorContext } : {}), pasted, files };
}

const INLINE_MAX_LINES = 10;
const INLINE_MAX_CHARS = 1000;

/** Long pastes become a removable attachment instead of flooding the input. */
export function classifyPaste(text: string): "inline" | "attachment" {
	return text.length > INLINE_MAX_CHARS || text.split("\n").length > INLINE_MAX_LINES ? "attachment" : "inline";
}
