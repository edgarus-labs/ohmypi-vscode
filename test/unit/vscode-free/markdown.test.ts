import * as assert from "node:assert/strict";
import { escapeHtml, renderMarkdown } from "../../../src/webview/markdown";

describe("renderMarkdown", () => {
	it("escapes raw HTML so injected handlers never become markup", () => {
		const html = renderMarkdown('hi <img src=x onerror="alert(1)"> & <script>bad()</script>');
		assert.ok(!html.includes("<img"), html);
		assert.ok(!html.includes("<script"), html);
		assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), html);
		assert.ok(html.includes("&amp;"), html);
	});

	it("never lets a fence language break out of its attribute", () => {
		const html = renderMarkdown('```" onmouseover="x\ncode\n```');
		assert.equal(html.includes("data-lang"), false, html);
		assert.equal(html.includes('onmouseover="'), false, html);
	});

	it("renders code fences as colored, escaped code under a language label and a Copy button", () => {
		const html = renderMarkdown("before\n```ts\nconst a = 1 < 2; // done\n```\nafter");
		assert.ok(
			html.includes(
				'<div class="md-code"><div class="code-head"><span class="code-lang">ts</span><button class="code-copy link" type="button" title="Copy code" aria-label="Copy code">Copy</button></div>',
			),
			html,
		);
		assert.ok(
			html.includes(
				'<pre class="code" data-lang="ts"><code><span class="tok-keyword">const</span> a = <span class="tok-number">1</span> &lt; <span class="tok-number">2</span>; <span class="tok-comment">// done</span></code></pre></div>',
			),
			html,
		);
		assert.ok(html.startsWith("<p>before</p>") && html.endsWith("<p>after</p>"), html);
	});

	it("keeps an unterminated fence (streaming) as code", () => {
		const html = renderMarkdown("```\npartial <b>");
		assert.match(html, /<pre class="code"><code>partial &lt;b&gt;<\/code><\/pre>/);
	});

	it("renders italics with asterisks or underscores, but not inside words or products", () => {
		assert.equal(renderMarkdown("an *em* and _under_ word, snake_case_name and 2*3*4"), "<p>an <em>em</em> and <em>under</em> word, snake_case_name and 2*3*4</p>");
		assert.equal(renderMarkdown("**bold** then *it*"), "<p><strong>bold</strong> then <em>it</em></p>");
	});

	it("renders web and mail links and bare https URLs as web links", () => {
		assert.equal(
			renderMarkdown("[docs](https://x.dev/a?b=1&c=2) or [me](mailto:me@x.dev)"),
			'<p><a class="web-link" href="#" data-url="https://x.dev/a?b=1&amp;c=2" title="https://x.dev/a?b=1&amp;c=2">docs</a> or <a class="web-link" href="#" data-url="mailto:me@x.dev" title="mailto:me@x.dev">me</a></p>',
		);
		assert.equal(
			renderMarkdown("see https://example.com/x_y. (and http://a.b/c)"),
			'<p>see <a class="web-link" href="#" data-url="https://example.com/x_y" title="https://example.com/x_y">https://example.com/x_y</a>. (and <a class="web-link" href="#" data-url="http://a.b/c" title="http://a.b/c">http://a.b/c</a>)</p>',
		);
	});

	it("never makes a bare URL of quoted or angle-bracketed text an attribute breakout", () => {
		const html = renderMarkdown('https://x.dev/"onmouseover="a <https://y.dev/>');
		assert.ok(html.includes('data-url="https://x.dev/"'), html);
		assert.ok(html.includes('data-url="https://y.dev/"'), html);
		assert.equal(html.includes("onmouseover=\""), false, html);
	});

	it("renders inline code and bold", () => {
		const html = renderMarkdown("use `a<b` and **strong** text");
		assert.ok(html.includes("<code>a&lt;b</code>"), html);
		assert.ok(html.includes("<strong>strong</strong>"), html);
	});

	it("renders links to other schemes as text, never as anchors", () => {
		const html = renderMarkdown("see [docs](javascript:alert(1))");
		assert.ok(!html.includes("<a"), html);
		assert.ok(html.includes("docs"), html);
		assert.ok(html.includes("javascript:alert(1)"), html);
	});

	it("does not interpret markdown inside inline code", () => {
		const html = renderMarkdown("`**x**`");
		assert.equal(html.includes("<strong>"), false, html);
	});

	it("renders inline code naming a file as a file link keeping the code look", () => {
		assert.equal(
			renderMarkdown("open `src/a.ts:12` or `npm`"),
			'<p>open <a class="file-link" href="#" data-path="src/a.ts" data-line="12"><code>src/a.ts:12</code></a> or <code>npm</code></p>',
		);
	});

	it("renders a markdown link to a file as a file link", () => {
		assert.equal(renderMarkdown("[entry](extension.ts)"), '<p><a class="file-link" href="#" data-path="extension.ts">entry</a></p>');
	});

	it("escapes quotes and angle brackets of a file path in link attributes", () => {
		const html = renderMarkdown("`src/\"'><svg onload=x>.ts` [y](src/\"><img>.ts)");
		assert.equal(html.includes("<svg"), false, html);
		assert.equal(html.includes("<img"), false, html);
		const link = renderMarkdown("`src/\"'><b>.ts`");
		assert.equal(link, '<p><a class="file-link" href="#" data-path="src/&quot;&#39;&gt;&lt;b&gt;.ts"><code>src/&quot;&#39;&gt;&lt;b&gt;.ts</code></a></p>');
		assert.equal(renderMarkdown('[y](src/"><i>.ts)'), '<p><a class="file-link" href="#" data-path="src/&quot;&gt;&lt;i&gt;.ts">y</a></p>');
	});

	it("escapes quotes and ampersands", () => {
		assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
	});

	it("renders bullet lists as ul with escaped, inline-formatted items", () => {
		assert.equal(renderMarkdown("- a <b>\n* **b**"), "<ul><li>a &lt;b&gt;</li><li><strong>b</strong></li></ul>");
	});

	it("renders ordered lists, keeping a non-1 start", () => {
		assert.equal(renderMarkdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
		assert.equal(renderMarkdown("3) three"), '<ol start="3"><li>three</li></ol>');
	});

	it("nests indented list items and appends continuation lines", () => {
		assert.equal(renderMarkdown("- a\n  - b\n    more\n- c"), "<ul><li>a<ul><li>b more</li></ul></li><li>c</li></ul>");
	});

	it("ends the paragraph before a list and starts a new one after it", () => {
		assert.equal(renderMarkdown("Intro:\n- a\n\nafter"), "<p>Intro:</p><ul><li>a</li></ul><p>after</p>");
	});

	it("does not treat a dash without a space as a list", () => {
		assert.equal(renderMarkdown("-not a list"), "<p>-not a list</p>");
	});

	it("renders pipe tables with header, alignment classes and a scroll wrapper", () => {
		const html = renderMarkdown("| A | B |\n| --- | ---: |\n| `x` | 2 |");
		assert.equal(
			html,
			'<div class="md-table"><table><thead><tr><th>A</th><th class="align-right">B</th></tr></thead><tbody><tr><td><code>x</code></td><td class="align-right">2</td></tr></tbody></table></div>',
		);
	});

	it("keeps pipe lines without a separator row as prose", () => {
		assert.equal(renderMarkdown("| a | b |"), "<p>| a | b |</p>");
	});

	it("renders headings as h3–h6 elements outside paragraphs", () => {
		assert.equal(renderMarkdown("intro\n# Title\n## Sub `x`\n#### Deep\ntext"), '<p>intro</p><h3 class="md-h">Title</h3><h4 class="md-h">Sub <code>x</code></h4><h6 class="md-h">Deep</h6><p>text</p>');
	});
});
