/** Pure text transforms for tool rows: cutting, argument lines, output cleanup, listings, diffs and search marks. */

/** `text` cut to its first `maxLines` lines, then to `maxChars` characters; unchanged when within both. */
export function cutTo(text: string, maxLines: number, maxChars: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines && text.length <= maxChars) return text;
	const shown = lines.slice(0, maxLines).join("\n");
	return shown.length > maxChars ? shown.slice(0, maxChars) : shown;
}

/** Indented JSON with `\n` line ends, as copying a tool's arguments yields them. */
export function indentedJson(value: unknown): string {
	return JSON.stringify(value ?? null, null, 2) ?? "null";
}

/** `name: value` lines: strings bare with their further lines indented, everything else as one line of JSON. */
export function flatLines(entries: Array<[string, unknown]>): string {
	return entries
		.map(([name, value]) => `${name}: ${typeof value === "string" ? value.replace(/\r\n/g, "\n").replace(/\n/g, "\n  ") : (JSON.stringify(value) ?? String(value))}`)
		.join("\n");
}

/** A call's arguments for reading: an object as one `name: value` line per property, anything else as indented JSON. */
export function flatArgs(args: unknown): string {
	return args !== null && typeof args === "object" && !Array.isArray(args) ? flatLines(Object.entries(args)) : indentedJson(args);
}

const TRAILER_LINE = /^(Wall time: .*|Command exited with code \d+)\s*$/;

/**
 * Shell output without the timing and exit-code lines OMP appends to it and the blank lines around them: the
 * header already carries the exit code. Lines of that shape inside the output stay.
 */
export function stripShellTrailer(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	while (lines.length > 0 && (lines[lines.length - 1].trim() === "" || TRAILER_LINE.test(lines[lines.length - 1]))) lines.pop();
	return lines.join("\n");
}

const FENCE_LINE = /^\s*```([\w#+.-]*)\s*$/;

/**
 * Tool output without the Markdown code fences around its code, and the language the first labeled fence names:
 * the output is shown as code anyway, so the fences only add noise.
 */
export function stripFences(text: string): { text: string; language: string | undefined } {
	let language: string | undefined;
	const kept = text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.filter(line => {
			const fence = FENCE_LINE.exec(line);
			if (fence && language === undefined && fence[1]) language = fence[1];
			return !fence;
		});
	return { text: kept.join("\n"), language };
}

const MAX_JSON_CHARS = 1_000_000;
const MAX_JSON_DEPTH = 64;

/**
 * The indented form of one line of JSON holding an object or array; `undefined` for anything else. Strings and
 * numbers are copied from the source verbatim, so nothing is decoded, normalized or reordered.
 */
export function prettyJson(text: string): string | undefined {
	const source = text.trim();
	if (source.length < 2 || source.length > MAX_JSON_CHARS || (source[0] !== "{" && source[0] !== "[") || /[\r\n]/.test(source)) return undefined;
	try {
		JSON.parse(source);
	} catch {
		return undefined;
	}
	let out = "";
	let depth = 0;
	const indent = () => `\n${"  ".repeat(depth)}`;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (c === '"') {
			let end = i + 1;
			while (source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
			out += source.slice(i, end + 1);
			i = end;
		} else if (c === "{" || c === "[") {
			let next = i + 1;
			while (source[next] === " " || source[next] === "\t") next++;
			if (source[next] === "}" || source[next] === "]") {
				out += c + source[next];
				i = next;
				continue;
			}
			if (++depth > MAX_JSON_DEPTH) return undefined;
			out += c + indent();
		} else if (c === "}" || c === "]") {
			depth--;
			out += indent() + c;
		} else if (c === ",") {
			out += `,${indent()}`;
		} else if (c === ":") {
			out += ": ";
		} else if (c !== " " && c !== "\t") {
			out += c;
		}
	}
	return out;
}

/** A file listing OMP numbered: the optional `[path#id]` header, one number (or range) per line, and the code without them. */
export interface Listing {
	header: string | undefined;
	numbers: string[];
	code: string;
}

const NUMBERED_LINE = /^(\*?(\d+)(?:-(\d+))?):(.*)$/;

function isBracketed(line: string): boolean {
	return line.startsWith("[") && line.endsWith("]");
}

/**
 * Splits a read result into its line-number gutter and clean code. Lines carry an `N:`, `*N:` or `N-M:` prefix;
 * `undefined` unless at least one does, each numbered line directly below another starts after the line or range
 * above it ends (gaps allowed), and, without a `[path#id]` header, numbered lines make up at least 60% of the
 * non-blank lines that are not OMP's `…` elisions or `[…]` notices.
 */
export function splitLineNumbers(text: string): Listing | undefined {
	const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	const header = lines.length > 0 && isBracketed(lines[0]) && lines[0].indexOf("#") > 1 ? lines[0] : undefined;
	const body = header === undefined ? lines : lines.slice(1);
	if (body.length === 0) return undefined;
	const numbers: string[] = [];
	const code: string[] = [];
	let numbered = 0;
	let filled = 0;
	let previousEnd: number | undefined;
	for (const line of body) {
		const match = NUMBERED_LINE.exec(line);
		const trimmed = line.trim();
		if (match || (trimmed !== "" && trimmed !== "…" && !isBracketed(trimmed))) filled++;
		if (match) {
			const from = Number(match[2]);
			if (previousEnd !== undefined && from <= previousEnd) return undefined;
			numbered++;
			previousEnd = Number(match[3] ?? match[2]);
		} else {
			previousEnd = undefined;
		}
		numbers.push(match ? match[1] : "");
		code.push(match ? match[4] : line);
	}
	if (numbered === 0 || (header === undefined && numbered * 5 < filled * 3)) return undefined;
	return { header, numbers, code: code.join("\n") };
}

const MARKDOWN_HEADING = /^#{1,6} \S/;

/** Whether tool output is Markdown prose: an ATX heading line and at least one other non-blank line, which code and plain output lack. */
export function looksLikeMarkdown(text: string): boolean {
	let headings = 0;
	let others = 0;
	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (MARKDOWN_HEADING.test(line)) headings++;
		else if (line.trim() !== "") others++;
	}
	return headings > 0 && others > 0;
}

/** Whether tool output is a unified diff: it has a `diff --git` header or an `@@` hunk line. */
export function looksLikeDiff(text: string): boolean {
	return /^(?:diff --git |@@ )/m.test(text);
}

export type DiffLineClass = "add" | "del" | "hunk" | "meta" | "ctx";

/**
 * The class of each diff line. `---` and `+++` lines are a file header only as a pair (`--- a/x` directly followed by
 * `+++ b/x`); alone they are a removed `--…` or an added `++…` line.
 */
export function diffLineClasses(lines: readonly string[]): DiffLineClass[] {
	return lines.map((line, index) => {
		if (line.startsWith("---") && lines[index + 1]?.startsWith("+++")) return "meta";
		if (line.startsWith("+++") && lines[index - 1]?.startsWith("---")) return "meta";
		if (line.startsWith("+")) return "add";
		if (line.startsWith("-")) return "del";
		if (line.startsWith("@@")) return "hunk";
		return "ctx";
	});
}

/** Within the text after a diff line's sign, the part that differs from the line it is paired with. */
export interface ChangedSpan {
	start: number;
	length: number;
}

const WORD_CHAR = /[\p{L}\p{Nd}_]/u;

function inWord(text: string, index: number): boolean {
	return index >= 0 && index < text.length && WORD_CHAR.test(text[index]);
}

function differing(removed: string, added: string): [ChangedSpan | undefined, ChangedSpan | undefined] {
	let prefix = 0;
	while (prefix < removed.length && prefix < added.length && removed[prefix] === added[prefix]) prefix++;
	let suffix = 0;
	while (suffix < removed.length - prefix && suffix < added.length - prefix && removed[removed.length - 1 - suffix] === added[added.length - 1 - suffix]) suffix++;
	while (prefix > 0 && inWord(removed, prefix - 1) && (inWord(removed, prefix) || inWord(added, prefix))) prefix--;
	while (suffix > 0 && inWord(removed, removed.length - suffix) && (inWord(removed, removed.length - suffix - 1) || inWord(added, added.length - suffix - 1))) suffix--;
	if (prefix + suffix === 0) return [undefined, undefined];
	const span = (length: number) => (length - prefix - suffix > 0 ? { start: prefix, length: length - prefix - suffix } : undefined);
	return [span(removed.length), span(added.length)];
}

/**
 * For each diff line, the part of its text (after the +/- sign) that differs from the line it replaces. A run of
 * removed lines followed by a run of added lines is paired line by line; within a pair the common start and end
 * are left out, widened to whole words, so a change of one or two words marks just those words. A pair with
 * nothing in common is left unmarked: the whole line is the change.
 */
export function changedSpans(lines: readonly string[]): Array<ChangedSpan | undefined> {
	const classes = diffLineClasses(lines);
	const spans: Array<ChangedSpan | undefined> = lines.map(() => undefined);
	let i = 0;
	while (i < lines.length) {
		if (classes[i] !== "del") {
			i++;
			continue;
		}
		const removedStart = i;
		while (i < lines.length && classes[i] === "del") i++;
		const addedStart = i;
		while (i < lines.length && classes[i] === "add") i++;
		const pairs = Math.min(addedStart - removedStart, i - addedStart);
		for (let p = 0; p < pairs; p++) {
			[spans[removedStart + p], spans[addedStart + p]] = differing(lines[removedStart + p].slice(1), lines[addedStart + p].slice(1));
		}
	}
	return spans;
}

/** Most search matches marked in one text; a pattern matching more marks only the first ones. */
const MAX_MARKS = 10_000;
/** Columns of a line searched for marks, which bounds a backtracking pattern's work on one line. */
const MARKED_COLUMNS = 1000;

/**
 * `[start, end)` of each non-empty match of the global `pattern` within a line of `text`, at most
 * {@link MAX_MARKS}. A longer line is searched in its first {@link MARKED_COLUMNS} columns, and a match reaching
 * that cut is left out, since the cut may have ended it.
 */
export function findMarks(text: string, pattern: RegExp): Array<{ start: number; end: number }> {
	const marks: Array<{ start: number; end: number }> = [];
	for (let start = 0; marks.length < MAX_MARKS; ) {
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline;
		const cut = end - start > MARKED_COLUMNS;
		const line = text.slice(start, cut ? start + MARKED_COLUMNS : end);
		pattern.lastIndex = 0;
		for (let match = pattern.exec(line); match && marks.length < MAX_MARKS; match = pattern.exec(line)) {
			const matchEnd = match.index + match[0].length;
			if (cut && matchEnd === line.length) break;
			if (match[0].length === 0) pattern.lastIndex++;
			else marks.push({ start: start + match.index, end: start + matchEnd });
		}
		if (newline < 0) break;
		start = newline + 1;
	}
	return marks;
}
