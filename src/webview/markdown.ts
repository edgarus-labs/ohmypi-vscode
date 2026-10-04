const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/** Inline spans on already-escaped text: `code`, **bold**, [text](url) shown as plain text. */
function renderInline(escaped: string): string {
	return escaped
		.split(/(`[^`\n]+`)/g)
		.map((part, index) => {
			if (index % 2 === 1) return `<code>${part.slice(1, -1)}</code>`;
			return part
				.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
				.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)");
		})
		.join("");
}

function renderProse(lines: string[]): string {
	return lines
		.map(line => {
			const heading = /^(#{1,6})\s+(.*)$/.exec(line);
			if (heading) return `<strong class="md-h">${renderInline(heading[2])}</strong>`;
			return renderInline(line);
		})
		.join("<br>");
}

/**
 * Minimal safe Markdown: the whole input is HTML-escaped first, then only a fixed
 * set of tags is produced (pre/code/strong/br). Raw HTML never survives.
 */
export function renderMarkdown(text: string): string {
	const lines = escapeHtml(text).split("\n");
	const out: string[] = [];
	let prose: string[] = [];
	let code: string[] | undefined;
	let lang = "";
	const flushProse = () => {
		if (prose.length > 0) out.push(`<p>${renderProse(prose)}</p>`);
		prose = [];
	};
	const flushCode = () => {
		const attr = lang ? ` data-lang="${lang}"` : "";
		out.push(`<pre class="code"${attr}><code>${(code ?? []).join("\n")}</code></pre>`);
		code = undefined;
	};
	for (const line of lines) {
		const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
		if (code) {
			if (fence && fence[1] === "") flushCode();
			else code.push(line);
		} else if (fence) {
			flushProse();
			code = [];
			lang = fence[1];
		} else if (line.trim() === "") {
			flushProse();
		} else {
			prose.push(line);
		}
	}
	if (code) flushCode();
	flushProse();
	return out.join("");
}
