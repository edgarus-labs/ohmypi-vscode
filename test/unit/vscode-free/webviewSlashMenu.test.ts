import * as assert from "node:assert/strict";
import type { SlashCommandView } from "../../../src/omp/api";
import { Composer } from "../../../src/webview/composer";
import { h } from "../../../src/webview/dom";
import { PersistedState } from "../../../src/webview/state";
import { click, event, type FakeVsCodeApi, fakeVsCodeApi, focused, scrolledIntoView, useDom } from "./webviewDom";

const COMMANDS: readonly SlashCommandView[] = [
	{ name: "model", source: "builtin", aliases: ["models"], description: "Pick the model\nfor this session", subcommands: [] },
	{
		name: "effort",
		source: "builtin",
		aliases: [],
		hint: "[level]",
		subcommands: [{ name: "off" }, { name: "minimal", description: "Least thinking" }, { name: "auto" }],
	},
	{ name: "skill:codebase-review", source: "skill", aliases: [], description: "Review the whole codebase", subcommands: [] },
];

describe("Composer slash command autocomplete", () => {
	useDom();
	let api: FakeVsCodeApi;
	let composer: Composer;

	beforeEach(() => {
		api = fakeVsCodeApi();
		composer = new Composer(
			{ post: message => api.postMessage(message), state: new PersistedState(api), notice: () => {}, onSubmit: () => {}, onAttachmentsChange: () => {} },
			{ modelPill: h("span"), fastButton: h("button"), usage: h("span") },
		);
		document.body.append(composer.element);
		composer.setStatus({ busy: false, unavailable: false });
		composer.setCommands(COMMANDS);
	});

	function type(text: string): void {
		composer.input.value = text;
		composer.input.dispatchEvent(event("input"));
	}

	function key(name: string, extra: Record<string, unknown> = {}): Event {
		const keydown = event("keydown", { key: name, shiftKey: false, isComposing: false, ...extra });
		composer.input.dispatchEvent(keydown);
		return keydown;
	}

	const listbox = () => composer.element.querySelector('[role="listbox"]');
	const isOpen = () => listbox()?.classList.contains("hidden") === false && composer.input.getAttribute("aria-expanded") === "true";
	const options = () => Array.from(composer.element.querySelectorAll('[role="option"]'));
	const optionNames = () => options().map(option => option.querySelector(".slash-name")?.textContent ?? "");
	const activeName = () => composer.element.querySelector('[aria-selected="true"] .slash-name')?.textContent;

	it("lists the commands for a leading slash as an accessible combobox", () => {
		assert.equal(composer.input.getAttribute("role"), "combobox");
		assert.equal(composer.input.getAttribute("aria-autocomplete"), "list");
		assert.equal(composer.input.getAttribute("aria-expanded"), "false");
		type("/");
		assert.ok(isOpen());
		assert.deepEqual(optionNames(), ["/model", "/effort", "/skill:codebase-review"]);
		const box = listbox();
		assert.ok(box);
		assert.equal(composer.input.getAttribute("aria-controls"), box.id);
		const first = options()[0];
		assert.equal(first.getAttribute("aria-selected"), "true");
		assert.equal(composer.input.getAttribute("aria-activedescendant"), first.id);
		type("hello");
		assert.equal(isOpen(), false);
		assert.equal(composer.input.hasAttribute("aria-activedescendant"), false);
	});

	it("shows the matched alias, hint, non-builtin source and full description", () => {
		type("/models");
		const [row] = options();
		assert.equal(row.querySelector(".slash-alias")?.textContent, "/models");
		assert.equal(row.getAttribute("title"), "Pick the model\nfor this session");
		type("/");
		const [, effort, skill] = options();
		assert.equal(effort.querySelector(".slash-hint")?.textContent, "[level]");
		assert.equal(effort.querySelector(".slash-badge"), null);
		assert.equal(skill.querySelector(".slash-badge")?.textContent, "skill");
		assert.equal(skill.querySelector(".slash-description")?.textContent, "Review the whole codebase");
	});

	it("moves the active row with the arrow keys, wrapping, and scrolls it into view", () => {
		type("/");
		assert.equal(key("ArrowDown").defaultPrevented, true);
		assert.equal(activeName(), "/effort");
		key("ArrowDown");
		key("ArrowDown");
		assert.equal(activeName(), "/model");
		key("ArrowUp");
		assert.equal(activeName(), "/skill:codebase-review");
		assert.ok(scrolledIntoView.at(-1) === composer.element.querySelector('[aria-selected="true"]'));
		assert.equal(composer.input.getAttribute("aria-activedescendant"), composer.element.querySelector('[aria-selected="true"]')?.id);
	});

	it("keeps the active row when the host re-sends the same commands", () => {
		type("/");
		key("ArrowDown");
		const activeId = composer.input.getAttribute("aria-activedescendant");
		composer.setCommands(structuredClone(COMMANDS));
		assert.equal(activeName(), "/effort");
		assert.equal(composer.input.getAttribute("aria-activedescendant"), activeId);
		key("Enter");
		assert.equal(composer.input.value, "/effort ");
	});

	it("inserts the active command on Enter without sending and keeps focus", () => {
		type("/mo");
		const enter = key("Enter");
		assert.equal(enter.defaultPrevented, true);
		assert.equal(composer.input.value, "/model ");
		assert.equal(composer.input.selectionStart, 7);
		assert.equal(api.postedOf("send").length, 0);
		assert.equal(api.state?.draft, "/model ");
		assert.ok(focused.at(-1) === composer.input);
		assert.equal(isOpen(), false);
	});

	it("inserts the active command on Tab", () => {
		type("/sk");
		assert.equal(key("Tab").defaultPrevented, true);
		assert.equal(composer.input.value, "/skill:codebase-review ");
	});

	it("replaces only the token around the caret", () => {
		composer.input.value = "/mo please";
		composer.input.selectionStart = 2;
		composer.input.dispatchEvent(event("input"));
		key("Enter");
		assert.equal(composer.input.value, "/model please");
		assert.equal(composer.input.selectionStart, 7);
	});

	it("reopens when the caret moves back into the first token", () => {
		type("/model x");
		assert.equal(isOpen(), false);
		composer.input.selectionStart = 3;
		composer.input.dispatchEvent(event("click"));
		assert.ok(isOpen());
		assert.deepEqual(optionNames(), ["/model"]);
	});

	it("lists subcommands after a command and inserts the chosen one", () => {
		type("/eff");
		key("Enter");
		assert.equal(composer.input.value, "/effort ");
		assert.ok(isOpen(), "subcommands open after accepting a command that has them");
		assert.deepEqual(optionNames(), ["off", "minimal", "auto"]);
		type("/effort m");
		assert.deepEqual(optionNames(), ["minimal"]);
		key("Enter");
		assert.equal(composer.input.value, "/effort minimal ");
		assert.equal(api.postedOf("send").length, 0);
	});

	it("closes on Escape until the first token changes", () => {
		type("/mo");
		assert.equal(key("Escape").defaultPrevented, true);
		assert.equal(isOpen(), false);
		type("/mo");
		assert.equal(isOpen(), false);
		type("/mod");
		assert.ok(isOpen());
	});

	it("sends on Enter while the list is closed", () => {
		type("/mo");
		key("Escape");
		key("Enter");
		assert.deepEqual(
			api.postedOf("send").map(send => send.text),
			["/mo"],
		);
	});

	it("ignores keys while an input method is composing", () => {
		type("/");
		key("ArrowDown", { isComposing: true });
		assert.equal(activeName(), "/model");
		key("Enter", { isComposing: true });
		assert.equal(composer.input.value, "/");
		assert.equal(api.postedOf("send").length, 0);
		key("Escape", { isComposing: true });
		assert.ok(isOpen());
	});

	it("keeps Shift+Enter for a new line", () => {
		type("/mo");
		assert.equal(key("Enter", { shiftKey: true }).defaultPrevented, false);
		assert.equal(composer.input.value, "/mo");
	});

	it("accepts a clicked row without taking focus from the input", () => {
		type("/");
		const [, effort] = options();
		const mousedown = event("mousedown");
		effort.dispatchEvent(mousedown);
		assert.equal(mousedown.defaultPrevented, true);
		assert.equal(composer.input.value, "/effort ");
		assert.equal(api.postedOf("send").length, 0);
	});

	it("shows a non-selectable row when nothing matches and lets Enter send", () => {
		type("/zzz");
		assert.ok(isOpen());
		const [row, ...more] = options();
		assert.equal(more.length, 0);
		assert.equal(row.textContent, "No matching commands");
		assert.equal(row.getAttribute("aria-disabled"), "true");
		assert.equal(row.getAttribute("aria-selected"), "false");
		assert.equal(composer.input.hasAttribute("aria-activedescendant"), false);
		key("Enter");
		assert.deepEqual(
			api.postedOf("send").map(send => send.text),
			["/zzz"],
		);
	});

	it("caps the list at 50 rows", () => {
		composer.setCommands(Array.from({ length: 80 }, (_, index) => ({ name: `cmd${index}`, source: "builtin", aliases: [], subcommands: [] })));
		type("/");
		assert.equal(options().length, 50);
	});

	it("re-filters when the commands change and never opens without commands", () => {
		type("/sk");
		assert.deepEqual(optionNames(), ["/skill:codebase-review"]);
		composer.setCommands([...COMMANDS, { name: "skills", source: "builtin", aliases: [], subcommands: [] }]);
		assert.deepEqual(optionNames(), ["/skill:codebase-review", "/skills"]);
		composer.setCommands([]);
		assert.equal(isOpen(), false);
		type("/");
		assert.equal(isOpen(), false);
	});

	it("closes when the prompt is sent", () => {
		type("/mo");
		click(composer.element.querySelector("button.send"));
		assert.equal(api.postedOf("send").length, 1);
		assert.equal(isOpen(), false);
	});

	it("closes when the input loses focus", () => {
		type("/");
		composer.input.dispatchEvent(event("blur"));
		assert.equal(isOpen(), false);
	});
});
