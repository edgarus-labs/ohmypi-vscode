import * as assert from "node:assert/strict";
import { toSlashCommands } from "../../src/omp/slashCommands";

describe("toSlashCommands", () => {
	it("maps OMP commands in order with aliases, hint and subcommands", () => {
		assert.deepEqual(
			toSlashCommands([
				{ name: "model", aliases: ["models"], description: "Pick a model", source: "builtin" },
				{
					name: "effort",
					description: "Set effort",
					input: { hint: "[level]" },
					subcommands: [{ name: "off", description: "No reasoning" }, { name: "auto", usage: "/effort auto" }],
					source: "builtin",
				},
				{ name: "skill:codebase-review", source: "skill" },
			]),
			[
				{ name: "model", source: "builtin", aliases: ["models"], description: "Pick a model", subcommands: [] },
				{
					name: "effort",
					source: "builtin",
					aliases: [],
					description: "Set effort",
					hint: "[level]",
					subcommands: [{ name: "off", description: "No reasoning" }, { name: "auto", usage: "/effort auto" }],
				},
				{ name: "skill:codebase-review", source: "skill", aliases: [], subcommands: [] },
			],
		);
	});

	it("drops entries without a non-empty string name", () => {
		assert.deepEqual(
			toSlashCommands([null, 7, "help", [], {}, { name: "" }, { name: "   " }, { name: 3 }, { name: "ok", source: "builtin" }])?.map(c => c.name),
			["ok"],
		);
	});

	it("replaces invalid optional fields with defaults", () => {
		assert.deepEqual(
			toSlashCommands([
				{ name: "a", aliases: "x", description: 5, input: "hint", subcommands: { name: "s" } },
				{ name: "b", aliases: ["ok", 1, "", null], input: { hint: 9 }, subcommands: [null, { name: "" }, { name: "s", description: 1, usage: ["u"] }], source: 4 },
				{ name: "c", input: null, subcommands: null, source: "" },
			]),
			[
				{ name: "a", source: "unknown", aliases: [], subcommands: [] },
				{ name: "b", source: "unknown", aliases: ["ok"], subcommands: [{ name: "s" }] },
				{ name: "c", source: "unknown", aliases: [], subcommands: [] },
			],
		);
	});

	it("returns undefined for a payload that is not an array", () => {
		for (const payload of [undefined, null, "x", 1, { commands: [] }]) assert.equal(toSlashCommands(payload), undefined);
	});
});
