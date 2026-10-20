import type { TranscriptItem, UsageView } from "../omp/api";
import { errorMessage } from "../shared/errors";
import { compactTokens, formatCost, turnSummaryText } from "../shared/format";
import { splitUserMessage } from "../shared/prompt";
import { lineCount } from "./chrome";
import type { RenderContext } from "./context";
import { copyButton } from "./copy";
import { collapsible, h } from "./dom";
import { type IconName, icon } from "./icons";
import { renderMarkdown } from "./markdown";
import { renderTool } from "./tools";

type UserItem = Extract<TranscriptItem, { kind: "user" }>;
type AssistantItem = Extract<TranscriptItem, { kind: "assistant" }>;

function renderUser(item: UserItem, ctx: RenderContext): HTMLElement {
	const parts = splitUserMessage(item.text);
	const fileChips = parts.files.map(file =>
		h("button", { class: "chip file", title: `Open ${file}`, onClick: () => ctx.post({ type: "openFile", path: file }) }, `@${file}`),
	);
	return h(
		"div",
		{ class: item.pending ? "item user pending" : "item user", attrs: { role: "group", "aria-label": "You" } },
		parts.text
			? parts.text.trimStart().startsWith("/")
				? h("div", { class: "command-prompt" }, icon("slashCommand", 18), h("code", { class: "text" }, parts.text))
				: h("div", { class: "text" }, parts.text)
			: null,
		item.expandedText !== undefined
			? collapsible(ctx, `${item.id}:expanded`, ["expanded command"], () => h("pre", { class: "out" }, item.expandedText ?? ""), false, "aside")
			: null,
		...parts.pasted.map((pasted, index) =>
			collapsible(ctx, `${item.id}:pasted:${index}`, [`${pasted.name} · ${lineCount(pasted.text)}`], () => h("pre", { class: "out" }, pasted.text), false, "aside"),
		),
		fileChips.length > 0 ? h("div", { class: "chips" }, ...fileChips) : null,
		parts.editorContext
			? collapsible(ctx, `${item.id}:ctx`, ["editor context"], () => h("pre", { class: "out" }, parts.editorContext ?? ""), false, "aside")
			: null,
		item.imageCount ? h("div", { class: "meta" }, `+${item.imageCount} image${item.imageCount === 1 ? "" : "s"}`) : null,
		h("div", { class: "msg-actions" }, copyButton(() => item.text, "Copy message")),
	);
}

function renderThinking(item: AssistantItem, ctx: RenderContext): HTMLElement | null {
	if (!item.thinking) return null;
	const lines = item.thinking.split("\n").filter(line => line.trim()).length;
	const label = item.streaming && !item.text ? "Thinking…" : `Thinking · ${lines} line${lines === 1 ? "" : "s"}`;
	const section = collapsible(ctx, `${item.id}:thinking`, [label], () => h("div", { class: "thinking" }, item.thinking), false, "aside thinking-block");
	section.dataset.part = "thinking";
	return section;
}

/**
 * Parts carry `data-part` so the transcript can patch a streaming reply into its existing node. The meta
 * line names the model; the reply's tokens and cost are in its tooltip, the turn summary adds them up.
 */
function renderAssistant(item: AssistantItem, ctx: RenderContext): HTMLElement {
	const body = h("div", { class: "md", attrs: { "data-part": "md" } });
	body.innerHTML = renderMarkdown(item.text);
	const meta: string[] = [];
	const usage: string[] = [];
	if (!item.streaming) {
		if (item.model) meta.push(item.model);
		if (item.stopReason && item.stopReason !== "stop" && item.stopReason !== "toolUse") meta.push(item.stopReason);
		if (item.usage) usage.push(`${compactTokens(item.usage.input)} in`, `${compactTokens(item.usage.output)} out`);
		if (item.usage?.costUsd !== undefined) usage.push(formatCost(item.usage.costUsd));
	}
	return h(
		"div",
		{ class: `item assistant${item.streaming ? " streaming" : ""}`, attrs: item.streaming ? { "aria-busy": "true" } : {} },
		renderThinking(item, ctx),
		body,
		item.errorMessage
			? h("div", { class: "notice level-error", attrs: { "data-part": "error" } }, icon("error", 14), h("span", { class: "notice-text" }, item.errorMessage))
			: null,
		meta.length > 0
			? h("div", { class: "meta msg-meta", ...(usage.length > 0 ? { title: usage.join(" · ") } : {}), attrs: { "data-part": "meta" } }, meta.join(" · "))
			: null,
		!item.streaming && item.text ? h("div", { class: "msg-actions" }, copyButton(() => item.text, "Copy reply")) : null,
	);
}

/** `1,200 input · 15,000 cache read · 0 cache write · 30 output tokens`. */
function turnUsageTitle(usage: UsageView): string {
	const count = (value: number) => value.toLocaleString("en-US");
	return `${count(usage.input)} input · ${count(usage.cacheRead)} cache read · ${count(usage.cacheWrite)} cache write · ${count(usage.output)} output tokens`;
}

const NOTICE_ICON: Record<string, IconName> = { error: "error", warning: "warning" };

/** One-line notice; click, Enter or Space expands it to the full text. */
function renderNotice(level: string, text: string): HTMLElement {
	const el = h(
		"div",
		{ class: `item notice level-${level}`, title: text, attrs: { role: "button", tabindex: "0", "aria-expanded": "false" } },
		icon(NOTICE_ICON[level] ?? "info", 14),
		h("span", { class: "notice-text" }, text),
	);
	const toggle = () => el.setAttribute("aria-expanded", String(el.classList.toggle("expanded")));
	el.addEventListener("click", toggle);
	el.addEventListener("keydown", event => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		toggle();
	});
	return el;
}

/** The node of one transcript item; a renderer failure becomes an error notice in its place. */
export function renderItem(item: TranscriptItem, ctx: RenderContext): HTMLElement {
	let el: HTMLElement;
	try {
		switch (item.kind) {
			case "user":
				el = renderUser(item, ctx);
				break;
			case "assistant":
				el = renderAssistant(item, ctx);
				break;
			case "tool":
				el = renderTool(item, ctx);
				el.classList.add("item");
				break;
			case "notice":
				el = renderNotice(item.level, item.text);
				break;
			case "command_output":
				el = h("pre", { class: "item out command-output" }, item.text);
				break;
			case "turn_summary":
				el = h("div", { class: "item turn-summary", title: turnUsageTitle(item.usage) }, turnSummaryText(item));
				break;
			default: {
				const unknownItem: { kind: string } = item;
				el = renderNotice("warning", `Unsupported item ${unknownItem.kind}`);
			}
		}
	} catch (error) {
		el = renderNotice("error", `Failed to render ${item.kind}: ${errorMessage(error)}`);
	}
	el.dataset.kind = item.kind;
	el.dataset.id = item.id;
	return el;
}
