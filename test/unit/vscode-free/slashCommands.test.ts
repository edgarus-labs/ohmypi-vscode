import * as assert from "node:assert/strict";
import type { SlashCommandView } from "../../../src/omp/api";
import { acceptSuggestion, firstToken, MAX_SLASH_ROWS, slashMenu } from "../../../src/webview/slashCommands";

function command(name: string, extra: Partial<SlashCommandView> = {}): SlashCommandView {
	return { name, source: "builtin", aliases: [], subcommands: [], ...extra };
}

const COMMANDS: readonly SlashCommandView[] = [
	command("model", { aliases: ["models"], description: "Pick the model" }),
	command("effort", {
		hint: "[level]",
		subcommands: [{ name: "off" }, { name: "minimal", description: "Least thinking" }, { name: "low" }, { name: "auto", usage: "auto" }],
	}),
	command("compact", { aliases: ["summarize"] }),
	command("skill:codebase-review", { source: "skill", description: "Review the whole codebase" }),
	command("new", { aliases: ["clear"] }),
];

const names = (text: string, caret = text.length, commands = COMMANDS) => slashMenu(text, caret, commands)?.items.map(item => item.name);

describe("slash command matching", () => {
	it("lists every command in OMP order for a bare slash", () => {
		assert.deepEqual(names("/"), ["model", "effort", "compact", "skill:codebase-review", "new"]);
	});

	it("ranks name prefixes, then alias prefixes, then name substrings", () => {
		const list = [command("review"), command("compact", { aliases: ["recap"] }), command("rename"), command("fire")];
		assert.deepEqual(names("/re", 3, list), ["review", "rename", "compact", "fire"]);
	});

	it("matches case-insensitively and reports the alias that matched", () => {
		const menu = slashMenu("/SUMM", 5, COMMANDS);
		assert.deepEqual(
			menu?.items.map(item => [item.name, item.alias]),
			[["compact", "summarize"]],
		);
		assert.equal(slashMenu("/mod", 4, COMMANDS)?.items[0]?.alias, undefined);
	});

	it("matches names containing a colon by substring", () => {
		assert.deepEqual(names("/review"), ["skill:codebase-review"]);
		assert.deepEqual(names("/skill:"), ["skill:codebase-review"]);
	});

	it("returns an empty list when nothing matches", () => {
		assert.deepEqual(names("/zzz"), []);
	});

	it("caps the list", () => {
		const many = Array.from({ length: MAX_SLASH_ROWS + 20 }, (_, index) => command(`cmd${index}`));
		assert.equal(names("/", 1, many)?.length, MAX_SLASH_ROWS);
	});

	it("labels non-builtin sources and carries hint and description", () => {
		const items = slashMenu("/", 1, COMMANDS)?.items ?? [];
		assert.deepEqual(
			items.map(item => [item.name, item.badge, item.hint, item.description]),
			[
				["model", undefined, undefined, "Pick the model"],
				["effort", undefined, "[level]", undefined],
				["compact", undefined, undefined, undefined],
				["skill:codebase-review", "skill", undefined, "Review the whole codebase"],
				["new", undefined, undefined, undefined],
			],
		);
	});

	it("opens only while the caret is inside a first token that starts with a slash", () => {
		assert.equal(slashMenu("/model", 6, []), undefined);
		assert.equal(slashMenu("model", 5, COMMANDS), undefined);
		assert.equal(slashMenu(" /model", 7, COMMANDS), undefined);
		assert.equal(slashMenu("/model x", 8, COMMANDS), undefined);
		assert.equal(slashMenu("/mo\nx", 5, COMMANDS), undefined);
		assert.deepEqual(names("/model rest", 3), ["model"]);
		assert.equal(slashMenu("/model rest", 3, COMMANDS)?.level, "command");
	});

	it("lists subcommands after an exact name or alias and a space", () => {
		assert.deepEqual(names("/effort "), ["off", "minimal", "low", "auto"]);
		assert.deepEqual(names("/effort m"), ["minimal"]);
		assert.deepEqual(names("/EFFORT o"), ["off", "low", "auto"]);
		const menu = slashMenu("/effort au", 10, COMMANDS);
		assert.equal(menu?.level, "subcommand");
		assert.deepEqual(
			menu?.items.map(item => [item.name, item.hint, item.badge]),
			[["auto", "auto", undefined]],
		);
		assert.equal(slashMenu("/model ", 7, COMMANDS), undefined, "no subcommands");
		assert.equal(slashMenu("/effor ", 7, COMMANDS), undefined, "not an exact name");
		assert.equal(slashMenu("/effort low x", 13, COMMANDS), undefined, "third token");
		const aliased = [command("thinking", { aliases: ["think"], subcommands: [{ name: "on" }] })];
		assert.deepEqual(names("/think ", 7, aliased), ["on"]);
	});

	it("replaces the current command token and keeps the rest of the text", () => {
		const menu = slashMenu("/mo rest", 2, COMMANDS);
		assert.ok(menu);
		assert.deepEqual(acceptSuggestion("/mo rest", menu, menu.items[0]), { text: "/model rest", caret: 7 });
		const bare = slashMenu("/mo", 3, COMMANDS);
		assert.ok(bare);
		assert.deepEqual(acceptSuggestion("/mo", bare, bare.items[0]), { text: "/model ", caret: 7 });
	});

	it("replaces the current subcommand token", () => {
		const menu = slashMenu("/effort mi", 10, COMMANDS);
		assert.ok(menu);
		assert.deepEqual(acceptSuggestion("/effort mi", menu, menu.items[0]), { text: "/effort minimal ", caret: 16 });
	});

	it("takes the first token up to the first whitespace", () => {
		assert.equal(firstToken("/effort low"), "/effort");
		assert.equal(firstToken("/mo\nx"), "/mo");
		assert.equal(firstToken(""), "");
	});
});
