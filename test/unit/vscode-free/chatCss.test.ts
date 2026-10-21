import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function repositoryRoot(): string {
	let dir = __dirname;
	while (!fs.existsSync(path.join(dir, "package.json"))) {
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`No package.json above ${__dirname}`);
		dir = parent;
	}
	return dir;
}

const css = fs.readFileSync(path.join(repositoryRoot(), "media", "chat.css"), "utf8").replaceAll("\r\n", "\n");

/** Declarations of the top-level rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
	const start = css.indexOf(`\n${selector} {\n`);
	assert.ok(start >= 0, `no rule for ${selector}`);
	const bodyStart = start + selector.length + 4;
	return css.slice(bodyStart, css.indexOf("\n}", bodyStart));
}

describe("chat.css", () => {
	it("wraps the composer row on narrow panels", () => {
		const body = rule(".composer-row");
		assert.match(body, /flex-wrap: wrap;/);
		assert.match(body, /row-gap: \d+px;/);
	});

	it("shows message metadata in the muted color at full opacity", () => {
		const body = rule(".msg-meta");
		assert.match(body, /color: var\(--muted\);/);
		assert.doesNotMatch(body, /opacity:/);
	});

	it("sizes text relative to the editor font instead of fixed pixels", () => {
		assert.deepEqual(css.match(/font-size: \d+px/g) ?? [], []);
	});

	it("shows expandable notices as clickable", () => {
		assert.match(rule(".item.notice"), /cursor: pointer;/);
	});

	it("anchors the slash command list above the composer within the panel", () => {
		assert.match(rule(".composer"), /position: relative;/);
		const menu = rule(".slash-menu");
		assert.match(menu, /position: absolute;/);
		assert.match(menu, /bottom: calc\(100% \+ \d+px\);/);
		assert.match(menu, /left: 0;/);
		assert.match(menu, /right: 0;/);
		assert.match(menu, /max-height: 40vh;/);
		assert.match(menu, /overflow-y: auto;/);
		assert.match(rule(".slash-description"), /text-overflow: ellipsis;/);
	});

	it("shows file links as links that keep their code look and a keyboard focus ring", () => {
		const link = rule(".file-link");
		assert.match(link, /color: var\(--vscode-textLink-foreground\);/);
		assert.match(link, /cursor: pointer;/);
		assert.match(link, /text-decoration: none;/);
		assert.match(rule(".md .file-link code"), /color: inherit;/);
		assert.match(rule(".file-link:hover"), /text-decoration: underline;/);
		assert.match(rule(".file-link:focus-visible"), /outline: 1px solid var\(--vscode-focusBorder\);/);
	});

	it("dims a user message OMP has not recorded yet", () => {
		const opacity = /opacity: ([\d.]+);/.exec(rule(".item.user.pending"))?.[1];
		assert.ok(opacity !== undefined && Number(opacity) > 0 && Number(opacity) < 1, `opacity ${opacity}`);
	});

	it("fades the working row in and keeps its ticking counters from jumping", () => {
		assert.match(rule(".working"), /animation: working-in [\d.]+s/);
		assert.match(css, /@keyframes working-in \{/);
		assert.match(rule(".working-detail"), /font-variant-numeric: tabular-nums;/);
	});

	it("shows a turn summary as one small, dim line", () => {
		const body = rule(".item.turn-summary");
		assert.match(body, /font-size: 0\.\d+em;/);
		const opacity = /opacity: ([\d.]+);/.exec(body)?.[1];
		assert.ok(opacity !== undefined && Number(opacity) > 0 && Number(opacity) < 1, `opacity ${opacity}`);
	});
});
