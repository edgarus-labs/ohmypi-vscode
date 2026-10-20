/** One replacement in a text buffer; lines and characters are 0-based, `end` exclusive. */
export interface LineEdit {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	text: string;
}

/** The lines of `text`, split at `\r\n`, `\r` and `\n`; a final line break leaves an empty last line. */
export function splitLines(text: string): string[] {
	return text.split(/\r\n|\r|\n/);
}

/** The 1-based inclusive line range to read: the whole document by default, `endLine` capped at its end. */
export function resolveRange(totalLines: number, startLine?: number, endLine?: number): { first: number; last: number } {
	const first = startLine ?? 1;
	const last = Math.min(endLine ?? totalLines, totalLines);
	if (first < 1) throw new Error(`startLine must be at least 1, got ${first}.`);
	if (first > totalLines) throw new Error(`The document has ${totalLines} lines; startLine ${first} is past the end.`);
	if (last < first) throw new Error(`endLine ${last} is before startLine ${first}.`);
	return { first, last };
}

/**
 * The buffer edit that replaces 1-based lines `startLine`..`endLine` with `text`: `endLine = startLine - 1`
 * inserts before `startLine` (`totalLines + 1` appends), empty `text` deletes the lines. The replacement's
 * own line breaks become `lineBreak`, and one trailing line break of it is ignored.
 */
export function planLineEdit(
	totalLines: number,
	lengthOfLine: (line: number) => number,
	startLine: number,
	endLine: number,
	text: string,
	lineBreak: string,
): LineEdit {
	if (startLine < 1) throw new Error(`startLine must be at least 1, got ${startLine}.`);
	if (endLine < startLine - 1) throw new Error(`endLine ${endLine} must be at least startLine - 1 (${startLine - 1}).`);
	if (startLine > totalLines + 1) {
		throw new Error(`The document has ${totalLines} lines; startLine ${startLine} is past the end (use ${totalLines + 1} to append).`);
	}
	if (endLine > totalLines) throw new Error(`The document has ${totalLines} lines; endLine ${endLine} is past the end.`);

	const replacement = text.length === 0 ? [] : splitLines(text);
	if (replacement.length > 1 && replacement.at(-1) === "") replacement.pop();
	const body = replacement.join(lineBreak);
	const first = startLine - 1;
	const last = totalLines - 1;
	if (endLine < totalLines) {
		return { startLine: first, startCharacter: 0, endLine, endCharacter: 0, text: replacement.length > 0 ? body + lineBreak : "" };
	}
	if (first === 0) return { startLine: 0, startCharacter: 0, endLine: last, endCharacter: lengthOfLine(last), text: body };
	return {
		startLine: first - 1,
		startCharacter: lengthOfLine(first - 1),
		endLine: last,
		endCharacter: lengthOfLine(last),
		text: replacement.length > 0 ? lineBreak + body : "",
	};
}
