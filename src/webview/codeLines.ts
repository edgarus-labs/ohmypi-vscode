import { type TokenKind, tokenize } from "./highlight";
import { findMarks } from "./toolText";

export interface CodeSegment {
	text: string;
	kind: TokenKind;
	/** Part of a search match. */
	marked: boolean;
}

/** One line of a code view: its gutter number (padded; `""` without a gutter) and its segments in order. */
export interface CodeLine {
	number: string;
	segments: CodeSegment[];
}

/**
 * What a code view draws: the gutter numbers of a numbered listing (a skipped `N-M` range becomes one empty
 * line), the code lexed by language, and search matches cutting the tokens into marked and unmarked segments.
 * @param numbers The gutter number of each line of `code`; `undefined` for code without a gutter.
 * @param mark A global pattern whose matches are marked; `undefined` marks nothing.
 */
export function codeLines(code: string, numbers: readonly string[] | undefined, language: string | undefined, mark: RegExp | undefined): CodeLine[] {
	const gutter = [...(numbers ?? [])];
	let text = code.replace(/\r\n/g, "\n");
	if (gutter.some(number => number.indexOf("-") > 0)) {
		const lines = text.split("\n");
		gutter.forEach((number, index) => {
			if (number.indexOf("-") > 0 && index < lines.length) {
				gutter[index] = "";
				lines[index] = "";
			}
		});
		text = lines.join("\n");
	}
	const width = Math.max(0, ...gutter.map(number => number.length));
	const marks = mark ? findMarks(text, mark) : [];
	const lines: CodeLine[] = [];
	let segments: CodeSegment[] = [];
	let nextMark = 0;
	const endLine = () => {
		lines.push({ number: lines.length < gutter.length ? gutter[lines.length].padStart(width) : "", segments });
		segments = [];
	};
	/** Adds `text[start, end)` split where a mark begins or ends; pieces come in text order, so `nextMark` only moves forward. */
	const addPiece = (start: number, end: number, kind: TokenKind) => {
		while (nextMark < marks.length && marks[nextMark].end <= start) nextMark++;
		let at = start;
		for (let i = nextMark; i < marks.length && marks[i].start < end; i++) {
			if (marks[i].start > at) {
				segments.push({ text: text.slice(at, marks[i].start), kind, marked: false });
				at = marks[i].start;
			}
			const stop = Math.min(marks[i].end, end);
			segments.push({ text: text.slice(at, stop), kind, marked: true });
			at = stop;
		}
		if (at < end) segments.push({ text: text.slice(at, end), kind, marked: false });
	};
	for (const token of tokenize(text, language)) {
		let start = token.start;
		while (start < token.end) {
			const newline = text.indexOf("\n", start);
			const stop = newline < 0 || newline >= token.end ? token.end : newline;
			addPiece(start, stop, token.kind);
			if (stop === token.end) break;
			endLine();
			start = newline + 1;
		}
	}
	endLine();
	return lines;
}
