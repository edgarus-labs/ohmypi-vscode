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

	it("renders code fences with escaped content and language class", () => {
		const html = renderMarkdown("before\n```ts\nconst a = 1 < 2;\n```\nafter");
		assert.match(html, /<pre class="code" data-lang="ts"><code>const a = 1 &lt; 2;<\/code><\/pre>/);
		assert.ok(html.includes("before"));
		assert.ok(html.includes("after"));
	});

	it("keeps an unterminated fence (streaming) as code", () => {
		const html = renderMarkdown("```\npartial <b>");
		assert.match(html, /<pre class="code"><code>partial &lt;b&gt;<\/code><\/pre>/);
	});

	it("renders inline code and bold", () => {
		const html = renderMarkdown("use `a<b` and **strong** text");
		assert.ok(html.includes("<code>a&lt;b</code>"), html);
		assert.ok(html.includes("<strong>strong</strong>"), html);
	});

	it("renders links as text, never as anchors", () => {
		const html = renderMarkdown("see [docs](javascript:alert(1))");
		assert.ok(!html.includes("<a"), html);
		assert.ok(html.includes("docs"), html);
		assert.ok(html.includes("javascript:alert(1)"), html);
	});

	it("does not interpret markdown inside inline code", () => {
		const html = renderMarkdown("`**x**`");
		assert.equal(html.includes("<strong>"), false, html);
	});

	it("escapes quotes and ampersands", () => {
		assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
	});
});
