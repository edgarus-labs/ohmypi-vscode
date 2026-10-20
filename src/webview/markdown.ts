import { copyText } from "./copy";
import { type FileLinkTarget, fileLinkTarget } from "./fileLinks";
import { tokenize } from "./highlight";

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const HTML_UNESCAPES: Record<string, string> = Object.fromEntries(Object.entries(HTML_ESCAPES).map(([raw, escaped]) => [escaped, raw]));

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

function unescapeHtml(escaped: string): string {
	return escaped.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => HTML_UNESCAPES[entity]);
}

function fileLink(target: FileLinkTarget, content: string): string {
	const line = target.line ? ` data-line="${target.line}"` : "";
	return `<a class="file-link" href="#" data-path="${escapeHtml(target.path)}"${line}>${content}</a>`;
}

/** An already-escaped `http(s)://` or `mailto:` URL as a link the host opens in the browser. */
function webLink(escapedUrl: string, content: string): string {
	return `<a class="web-link" href="#" data-url="${escapedUrl}" title="${escapedUrl}">${content}</a>`;
}

const WEB_URL = /^(?:https?:\/\/|mailto:)\S+$/i;

/**
 * On escaped text: `[text](url)`, `**bold**`, `*italic*` / `_italic_` (not inside words, so `snake_case` and
 * `2*3*4` stay), and bare `http(s)://` URLs, which end before whitespace or an escaped quote or angle bracket.
 */
const SPAN =
	/\[([^[\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|(?<![*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?![*\w])|(?<!\w)_([^_\s](?:[^_\n]*[^_\s])?)_(?!\w)|\bhttps?:\/\/(?:(?!&(?:lt|gt|quot|#39);)[^\s`])+/gi;

/** Sentence punctuation after a bare URL, and a closing parenthesis the URL did not open; an entity's `;` stays. */
function splitUrlTail(url: string): [string, string] {
	let end = url.length;
	for (;;) {
		const head = url.slice(0, end);
		const last = head[head.length - 1];
		const unbalanced = last === ")" && head.split("(").length < head.split(")").length;
		if ((/[.,:!?]/.test(last) || (last === ";" && !/&(?:\w+|#\d+);$/.test(head)) || unbalanced) && end > 0) end--;
		else return [head, url.slice(end)];
	}
}

/** Links, bold and italics on already-escaped text outside code spans. */
function renderSpans(escaped: string): string {
	return escaped.replace(SPAN, (match, linkText?: string, linkUrl?: string, bold?: string, star?: string, underscore?: string) => {
		if (linkText !== undefined && linkUrl !== undefined) {
			if (WEB_URL.test(unescapeHtml(linkUrl))) return webLink(linkUrl, linkText);
			const target = fileLinkTarget(unescapeHtml(linkUrl));
			return target ? fileLink(target, linkText) : `${linkText} (${linkUrl})`;
		}
		if (bold !== undefined) return `<strong>${bold}</strong>`;
		if (star !== undefined || underscore !== undefined) return `<em>${star ?? underscore}</em>`;
		const [url, tail] = splitUrlTail(match);
		return webLink(url, url) + tail;
	});
}

/**
 * Inline spans on already-escaped text: `code`, links, bold and italics; code or link targets naming a file
 * become file links, web and mail links (and bare web URLs) web links, other links plain text.
 */
function renderInline(escaped: string): string {
	return escaped
		.split(/(`[^`\n]+`)/g)
		.map((part, index) => {
			if (index % 2 === 0) return renderSpans(part);
			const code = part.slice(1, -1);
			const target = fileLinkTarget(unescapeHtml(code));
			return target ? fileLink(target, `<code>${code}</code>`) : `<code>${code}</code>`;
		})
		.join("");
}

/** Escaped code with its tokens in `tok-<kind>` spans. */
function highlightedCode(code: string, language: string): string {
	return tokenize(code, language)
		.map(token => {
			const text = escapeHtml(code.slice(token.start, token.end));
			return token.kind === "text" ? text : `<span class="tok-${token.kind}">${text}</span>`;
		})
		.join("");
}

/** A click on the Copy button of a Markdown code block below `root` copies the block's code. */
export function listenForCodeCopy(root: HTMLElement): void {
	root.addEventListener("click", event => {
		const button = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(".code-copy") : null;
		const code = button?.closest(".md-code")?.querySelector("pre code");
		if (!button || !code || !root.contains(button)) return;
		event.preventDefault();
		event.stopPropagation();
		void copyText(code.textContent ?? "", button);
	});
}

/** `#` … `######`; rendered as `<h3>` … `<h6>` because the chat panel already sits below the view title. */
const HEADING = /^(#{1,6})\s+(.*)$/;

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Nested `<ul>`/`<ol>` from list item lines; indented non-item lines continue the previous item. */
function renderList(lines: string[]): string {
	let html = "";
	const stack: Array<{ indent: number; tag: "ul" | "ol" }> = [];
	const close = () => (html += `</li></${stack.pop()?.tag}>`);
	for (const line of lines) {
		const item = LIST_ITEM.exec(line);
		if (!item) {
			html += ` ${renderInline(line.trim())}`;
			continue;
		}
		const indent = item[1].length;
		const ordered = /\d/.test(item[2]);
		const tag = ordered ? "ol" : "ul";
		while (stack.length > 0 && indent < stack[stack.length - 1].indent) close();
		const top = stack[stack.length - 1];
		if (top && indent === top.indent && top.tag === tag) {
			html += "</li>";
		} else {
			if (top && indent === top.indent) close();
			const start = ordered ? Number.parseInt(item[2], 10) : 1;
			html += `<${tag}${start !== 1 ? ` start="${start}"` : ""}>`;
			stack.push({ indent, tag });
		}
		html += `<li>${renderInline(item[3])}`;
	}
	while (stack.length > 0) close();
	return html;
}

function tableCells(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map(cell => cell.trim());
}

function renderTable(header: string, separator: string, rows: string[]): string {
	const aligns = tableCells(separator).map(cell => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : ""));
	const [head, ...body] = [header, ...rows].map((row, rowIndex) => {
		const tag = rowIndex === 0 ? "th" : "td";
		const cells = tableCells(row).map((text, index) => `<${tag}${aligns[index] ? ` class="align-${aligns[index]}"` : ""}>${renderInline(text)}</${tag}>`);
		return `<tr>${cells.join("")}</tr>`;
	});
	return `<div class="md-table"><table><thead>${head}</thead><tbody>${body.join("")}</tbody></table></div>`;
}

/**
 * Minimal safe Markdown: the whole input is HTML-escaped first, then only a fixed set of tags is
 * produced (code blocks with token spans and a Copy button, code/strong/em/br/h3–h6/lists/tables,
 * `a.file-link` with `href="#"` and escaped `data-path`/`data-line`, and `a.web-link` with `href="#"`
 * and an escaped web or mail `data-url`). Raw HTML never survives.
 */
export function renderMarkdown(text: string): string {
	const lines = escapeHtml(text).split("\n");
	const out: string[] = [];
	let prose: string[] = [];
	let list: string[] = [];
	let code: string[] | undefined;
	let lang = "";
	const flushProse = () => {
		if (prose.length > 0) out.push(`<p>${prose.map(renderInline).join("<br>")}</p>`);
		prose = [];
	};
	const flushList = () => {
		if (list.length > 0) out.push(renderList(list));
		list = [];
	};
	const flushCode = () => {
		const attr = lang ? ` data-lang="${lang}"` : "";
		const copy = '<button class="code-copy link" type="button" title="Copy code" aria-label="Copy code">Copy</button>';
		const body = highlightedCode(unescapeHtml((code ?? []).join("\n")), lang);
		out.push(`<div class="md-code"><div class="code-head"><span class="code-lang">${lang}</span>${copy}</div><pre class="code"${attr}><code>${body}</code></pre></div>`);
		code = undefined;
	};
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
		const heading = HEADING.exec(line);
		if (code) {
			if (fence && fence[1] === "") flushCode();
			else code.push(line);
		} else if (fence) {
			flushProse();
			flushList();
			code = [];
			lang = fence[1];
		} else if (line.trim() === "") {
			flushProse();
			const next = lines.slice(index + 1).find(candidate => candidate.trim() !== "");
			if (next === undefined || !(LIST_ITEM.test(next) || /^\s/.test(next))) flushList();
		} else if (LIST_ITEM.test(line) || (list.length > 0 && /^\s/.test(line))) {
			flushProse();
			list.push(line);
		} else if (line.trim().startsWith("|") && index + 1 < lines.length && lines[index + 1].includes("|") && TABLE_SEPARATOR.test(lines[index + 1])) {
			flushProse();
			flushList();
			const rows: string[] = [];
			let next = index + 2;
			while (next < lines.length && lines[next].trim().startsWith("|")) rows.push(lines[next++]);
			out.push(renderTable(line, lines[index + 1], rows));
			index = next - 1;
		} else if (heading) {
			flushProse();
			flushList();
			const level = Math.min(heading[1].length + 2, 6);
			out.push(`<h${level} class="md-h">${renderInline(heading[2])}</h${level}>`);
		} else {
			flushList();
			prose.push(line);
		}
	}
	if (code) flushCode();
	flushProse();
	flushList();
	return out.join("");
}
