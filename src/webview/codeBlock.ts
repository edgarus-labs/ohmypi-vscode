import { type CodeLine, codeLines } from "./codeLines";
import type { RenderContext } from "./context";
import { copyText } from "./copy";
import { h } from "./dom";
import { renderMarkdown } from "./markdown";
import { type ChangedSpan, changedSpans, cutTo, type DiffLineClass, diffLineClasses, splitLineNumbers } from "./toolText";

/** Lines and characters of a closed row's dim preview. */
export const PREVIEW_LINES = 5;
export const PREVIEW_CHARS = 2000;
/** Most lines and characters an open row puts on screen; the rest stays one "Copy all" away. */
export const EXPANDED_LINES = 2000;
export const EXPANDED_CHARS = 200_000;
/** Diff lines shown before "show more", and at most after it. */
const DIFF_PREVIEW_LINES = 20;
const DIFF_LINES = 2000;

/** The tool row a block belongs to: whether it is open, and how to open, close or redraw it from one of its controls. */
export interface RowView {
	readonly ctx: RenderContext;
	readonly expanded: boolean;
	/** The row closes by its own "collapse" under the header, so its blocks offer none. */
	readonly closesToHeader: boolean;
	/** Opens or closes the row, then focuses its control whose `data-action` is `focus`. */
	readonly setExpanded: (from: Element, expanded: boolean, focus: string) => void;
	/** Draws the row again, e.g. after a remembered state of one of its blocks changed, then focuses its control whose `data-action` is `focus`, if any. */
	refresh(from: Element, focus?: string): void;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function linkButton(label: string, onClick: (button: HTMLButtonElement) => void, action?: string): HTMLButtonElement {
	const button: HTMLButtonElement = h(
		"button",
		{ class: "link", attrs: { type: "button", ...(action ? { "data-action": action } : {}) }, onClick: () => onClick(button) },
		label,
	);
	return button;
}

/**
 * The "show more" (`open`) or "collapse" button of the block named `block` in its row, marked `more:<block>` or
 * `collapse:<block>`: `apply` opens or closes what the block shows and redraws the row, focusing the block's other one.
 */
export function toggleButton(label: string, block: string, open: boolean, apply: (from: Element, open: boolean, focus: string) => void): HTMLButtonElement {
	return linkButton(label, button => apply(button, open, `${open ? "collapse" : "more"}:${block}`), `${open ? "more" : "collapse"}:${block}`);
}

function copyAllButton(label: string, text: string): HTMLButtonElement {
	const button = linkButton(label, () => void copyText(text, button));
	button.setAttribute("aria-label", label);
	return button;
}

function linksLine(...links: Array<HTMLElement | null>): HTMLElement | null {
	const present = links.filter((link): link is HTMLElement => link !== null);
	return present.length > 0 ? h("div", { class: "code-links" }, ...present) : null;
}

/** Appends the colored lines of `code` to `target`, one `\n` text node between lines. */
function fillCode(target: HTMLElement, lines: CodeLine[]): void {
	lines.forEach((line, index) => {
		if (index > 0) target.append("\n");
		for (const segment of line.segments) {
			if (segment.kind === "text" && !segment.marked) {
				target.append(segment.text);
				continue;
			}
			const classes = [segment.kind === "text" ? "" : `tok-${segment.kind}`, segment.marked ? "tok-mark" : ""].filter(Boolean).join(" ");
			target.append(h("span", { class: classes }, segment.text));
		}
	});
}

export interface CodeOptions {
	/** What copying the whole block yields when it differs from what is shown (reformatted text). */
	copy?: string;
	/** Language whose tokens are colored. */
	language?: string;
	/** Global pattern whose matches are marked. */
	mark?: RegExp;
	/** Extra class of the block (`quiet` for input). */
	className?: string;
}

/**
 * A tool's text as one block named `block` in its row: cut to the preview while the row is closed, to the open
 * limits in a scrolling viewport while it is open, with "show more", "collapse" and "Copy all" as they apply. A
 * numbered listing is split into an unselectable gutter and code once, so the preview and the open text number their
 * lines alike; code gets token colors and search marks. Text without a language, marks or numbers wraps as plain
 * text. `null` for empty text.
 */
export function codeBlock(row: RowView, block: string, text: string, options: CodeOptions = {}): HTMLElement | null {
	const trimmed = text.replace(/[\r\n]+$/, "");
	if (!trimmed) return null;
	const listing = splitLineNumbers(text);
	const body = listing?.code ?? trimmed;
	const lineCount = body.split("\n").length;
	const shown = row.expanded ? cutTo(body, EXPANDED_LINES, EXPANDED_CHARS) : cutTo(body, PREVIEW_LINES, PREVIEW_CHARS);
	const cut = shown.length < body.length;
	const plain = !options.language && !options.mark && !listing;
	const code = h("code");
	const lines = plain ? undefined : codeLines(shown, listing?.numbers.slice(0, shown.split("\n").length), options.language, options.mark);
	if (lines) fillCode(code, lines);
	else code.textContent = shown;
	const pre = h("pre", { class: "code-text" }, code);
	const original = options.copy !== undefined && options.copy !== text ? options.copy : undefined;
	pre.addEventListener("copy", event => {
		const clipboard = event.clipboardData;
		if (cut || original === undefined || !clipboard || document.getSelection()?.toString() !== pre.textContent) return;
		clipboard.setData("text/plain", original);
		event.preventDefault();
	});
	const gutter = listing && lines ? h("pre", { class: "code-gutter", attrs: { "aria-hidden": "true" } }, lines.map(line => line.number).join("\n")) : null;
	const classes = ["code-view", listing ? "numbered" : "", plain ? "plain" : "", row.expanded ? "expanded" : ""].filter(Boolean).join(" ");
	const longerThanPreview = lineCount > PREVIEW_LINES || body.length > PREVIEW_CHARS;
	return h(
		"div",
		{ class: `code-block${options.className ? ` ${options.className}` : ""}` },
		h("div", { class: classes }, gutter, pre),
		linksLine(
			cut && !row.expanded ? toggleButton(`show more (${plural(lineCount, "line")})`, block, true, row.setExpanded) : null,
			row.expanded && longerThanPreview && !row.closesToHeader ? toggleButton("collapse", block, false, row.setExpanded) : null,
			cut && row.expanded ? copyAllButton(`Copy all ${plural(lineCount, "line")}`, original ?? text) : null,
		),
	);
}

/** Markdown prose rendered from `source` (its lines count for the labels) as the block named `block` in its row, cut to a preview height while the row is closed. */
export function proseBlock(row: RowView, block: string, source: string): HTMLElement {
	const lineCount = source.replace(/[\r\n]+$/, "").split("\n").length;
	const cut = !row.expanded && lineCount > PREVIEW_LINES;
	const prose = h("div", { class: "md" });
	prose.innerHTML = renderMarkdown(source);
	return h(
		"div",
		{ class: "code-block" },
		h("div", { class: `code-view prose${cut ? " cut" : ""}${row.expanded ? " expanded" : ""}` }, prose),
		linksLine(
			cut ? toggleButton(`show more (${plural(lineCount, "line")})`, block, true, row.setExpanded) : null,
			row.expanded && lineCount > PREVIEW_LINES && !row.closesToHeader ? toggleButton("collapse", block, false, row.setExpanded) : null,
		),
	);
}

function diffLine(line: string, kind: DiffLineClass, changed: ChangedSpan | undefined): HTMLElement {
	const el = h("div", { class: `diff-line d-${kind}` });
	if (kind !== "add" && kind !== "del") {
		el.textContent = line || " ";
		return el;
	}
	const text = line.slice(1);
	el.append(h("span", { class: "d-sign" }, line[0]));
	if (!changed) {
		if (text) el.append(text);
		return el;
	}
	if (changed.start > 0) el.append(text.slice(0, changed.start));
	el.append(h("span", { class: "d-word" }, text.slice(changed.start, changed.start + changed.length)));
	if (changed.start + changed.length < text.length) el.append(text.slice(changed.start + changed.length));
	return el;
}

/**
 * A unified diff as full-width tinted lines with only the +/- sign colored and the changed words of paired lines
 * on a stronger tint, as the block named `block` in its row: the first lines with "show more" (remembered under
 * `key`), which shows up to the diff limit with "collapse", and "Copy all" past that limit.
 */
export function diffView(row: RowView, block: string, key: string, diff: string): HTMLElement {
	const lines = diff.replace(/\n+$/, "").split("\n");
	const open = row.ctx.isOpen(key) === true;
	const shown = lines.slice(0, open ? DIFF_LINES : DIFF_PREVIEW_LINES);
	const classes = diffLineClasses(lines);
	const spans = changedSpans(shown);
	const view = h("div", { class: "diff-view" }, ...shown.map((line, index) => diffLine(line, classes[index], spans[index])));
	if (lines.length <= DIFF_PREVIEW_LINES) return h("div", { class: "code-block" }, view);
	const apply = (from: Element, expand: boolean, focus: string) => {
		row.ctx.setOpen(key, expand);
		row.refresh(from, focus);
	};
	const withheld = shown.length < lines.length;
	const links = open
		? linksLine(
				withheld ? h("span", { class: "meta" }, `Showing the first ${DIFF_LINES} of ${lines.length} lines.`) : null,
				withheld ? copyAllButton(`Copy all ${lines.length} diff lines`, diff) : null,
				toggleButton("collapse", block, false, apply),
			)
		: linksLine(toggleButton(`show more (${lines.length} lines)`, block, true, apply));
	return h("div", { class: "code-block" }, view, links);
}
