import type { ConnectionStatus, InteractionRequest, InteractionResponse, PromptMode, SessionView, TranscriptItem } from "../omp/api";
import { errorMessage } from "../ui/guards";
import { type AskQuestionState, buildAskAnswers } from "./ask";
import { effortChoices, elapsedText, formatCost, isAtBottom, stateWord, todoSummary, usageText } from "./chrome";
import { collapsible, h } from "./dom";
import { renderMarkdown } from "./markdown";
import type { Attachment, HostMessage, PendingInteraction, WebviewMessage } from "./protocol";
import { renderTool, type ToolRenderContext } from "./tools";
import { classifyPaste, splitUserMessage } from "./userMessage";

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: SavedState): void;
}

interface SavedState {
	draft: string;
	includeContext?: boolean;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const saved: SavedState = (vscode.getState() as SavedState | undefined) ?? { draft: "" };
const post = (message: WebviewMessage) => vscode.postMessage(message);

const openState = new Map<string, boolean>();
const ctx: ToolRenderContext = {
	post,
	isOpen: key => openState.get(key),
	setOpen: (key, open) => openState.set(key, open),
};

let session: SessionView = {
	phase: "idle",
	availableThinkingLevels: [],
	isStreaming: false,
	isCompacting: false,
	queue: { steering: [], followUp: [] },
	todos: [],
};
let connection: ConnectionStatus = { state: "stopped" };
let unavailable: string | undefined;
const itemNodes = new Map<string, HTMLElement>();
const interactionNodes = new Map<string, HTMLElement>();
const expiries = new Map<string, number>();
let localNoticeSequence = 0;
let countdownTimer: number | undefined;
let contextToggleInitialized = false;
/** Epoch ms when the current turn started (webview-local); drives the elapsed counter. */
let busySince: number | undefined;
let busyTimer: number | undefined;
/** Follow new output only while the reader is already at the bottom. */
let stickToBottom = true;

// ── Layout ───────────────────────────────────────────────────────────────────

const command = (name: Extract<WebviewMessage, { type: "command" }>["command"]) => () => post({ type: "command", command: name });

const stateDot = h("span", { class: "dot", attrs: { "aria-hidden": "true" } });
const stateLabel = h("span", { class: "state-word" });
const sessionButton = h("button", { class: "plain session-name", onClick: command("omp.renameSession") });
const modelButton = h("button", { class: "plain model", title: "Select model", onClick: command("omp.selectModel") });
const thinkingSelect = h("select", { class: "thinking", title: "Reasoning effort", attrs: { "aria-label": "Reasoning effort" } });
thinkingSelect.addEventListener("change", () => post({ type: "setThinkingLevel", level: thinkingSelect.value }));
const fastButton = h("button", { class: "plain fast", title: "Fast mode", onClick: command("omp.toggleFastMode") }, "fast");
const usageLabel = h("span", { class: "usage" });
const activityLabel = h("span", { class: "activity" });
const header = h(
	"div",
	{ class: "header" },
	h("span", { class: "state" }, stateDot, stateLabel),
	sessionButton,
	activityLabel,
	h("span", { class: "spacer" }),
	usageLabel,
);

const banner = h("div", { class: "banner hidden" });
const column = h("div", { class: "column", attrs: { role: "log", "aria-live": "polite" } });
const scroller = h("div", { class: "scroller" }, column);
const emptyHint = h("div", { class: "empty" });
const jumpButton = h(
	"button",
	{
		class: "jump hidden",
		title: "Scroll to the latest output",
		onClick: () => {
			stickToBottom = true;
			scrollToBottom();
		},
	},
	"jump to latest ↓",
);
const main = h("div", { class: "main" }, scroller, jumpButton);

const statusLine = h("div", { class: "statusline" });
const queueBox = h("div", { class: "queue" });
const todosBox = h("div", { class: "todos" });
const interactionsBox = h("div", { class: "interactions" });
const input = h("textarea", { class: "input", attrs: { rows: "2", "aria-label": "Prompt" } });
/** Files, pasted text and images attached to the next prompt. */
let attachments: Attachment[] = [];
let pastedTextSequence = 0;
let imageSequence = 0;
const attachmentBar = h("div", { class: "attachments hidden" });
const addContextButton = h(
	"button",
	{ class: "plain add-context", title: "Add files to the chat (open editors, workspace)", attrs: { "aria-label": "Add files" }, onClick: () => post({ type: "pickContext" }) },
	"+",
);
input.value = saved.draft;
const contextToggle = h("input", { attrs: { type: "checkbox", id: "ctx-toggle" } });
const followUpButton = h("button", { class: "secondary", title: "Queue as follow-up after the current turn", onClick: () => submit("followUp") }, "Follow-up");
const stopButton = h("button", { class: "secondary", title: "Abort the current turn", onClick: () => post({ type: "abort" }) }, "Stop");
const sendButton = h("button", { class: "primary", onClick: () => submit(isBusy() ? "steer" : "auto") }, "Send");
const composer = h(
	"div",
	{ class: "composer" },
	attachmentBar,
	input,
	h(
		"div",
		{ class: "composer-row" },
		addContextButton,
		modelButton,
		thinkingSelect,
		fastButton,
		h(
			"label",
			{ class: "toggle-label", title: "Attach editor context: active file, selection, open editors, diagnostics", attrs: { for: "ctx-toggle" } },
			contextToggle,
			h("span", { class: "toggle-text" }, "context"),
		),
		h("span", { class: "composer-actions" }, followUpButton, stopButton, sendButton),
	),
);
const dock = h("div", { class: "dock" }, h("div", { class: "dock-inner" }, statusLine, queueBox, todosBox, interactionsBox, composer));

document.getElementById("app")?.append(header, banner, main, dock);

function saveState(): void {
	vscode.setState({ draft: input.value, includeContext: contextToggle.checked });
}

function isBusy(): boolean {
	return session.phase !== "idle";
}

/** Grows the composer with its content between two rows and 40% of the panel height. */
function autosize(): void {
	input.style.height = "auto";
	const max = Math.max(48, Math.floor(window.innerHeight * 0.4));
	const wanted = input.scrollHeight + 2;
	input.style.height = `${Math.min(wanted, max)}px`;
	input.style.overflowY = wanted > max ? "auto" : "hidden";
}

function submit(mode: PromptMode): void {
	const text = input.value;
	if ((!text.trim() && attachments.length === 0) || unavailable) return;
	post({ type: "send", text, mode, includeContext: contextToggle.checked, attachments });
	setAttachments([]);
	input.value = "";
	autosize();
	saveState();
	stickToBottom = true;
	scrollToBottom();
}

input.addEventListener("input", () => {
	autosize();
	saveState();
});
contextToggle.addEventListener("change", saveState);
input.addEventListener("keydown", event => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		submit(isBusy() ? "steer" : "auto");
	}
});
window.addEventListener("resize", autosize);

// ── Scrolling ────────────────────────────────────────────────────────────────

function scrollToBottom(): void {
	scroller.scrollTop = scroller.scrollHeight;
	jumpButton.classList.add("hidden");
}

function followOutput(): void {
	if (stickToBottom) scrollToBottom();
	else jumpButton.classList.remove("hidden");
}

scroller.addEventListener("scroll", () => {
	stickToBottom = isAtBottom(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight);
	jumpButton.classList.toggle("hidden", stickToBottom);
});
new ResizeObserver(() => {
	if (stickToBottom) scrollToBottom();
}).observe(column);
new ResizeObserver(() => {
	if (stickToBottom) scrollToBottom();
}).observe(scroller);

// ── Transcript ───────────────────────────────────────────────────────────────

function renderUser(item: Extract<TranscriptItem, { kind: "user" }>): HTMLElement {
	const parts = splitUserMessage(item.text);
	const fileChips = parts.files.map(file =>
		h("button", { class: "chip file", title: `Open ${file}`, onClick: () => post({ type: "openFile", path: file }) }, `@${file}`),
	);
	return h(
		"div",
		{ class: "item user", attrs: { "aria-label": "You" } },
		parts.text ? h("div", { class: "text" }, parts.text) : null,
		...parts.pasted.map((pasted, index) =>
			collapsible(ctx, `${item.id}:pasted:${index}`, [`${pasted.name} · ${lineCount(pasted.text)}`], () => h("pre", { class: "out" }, pasted.text), false, "aside"),
		),
		fileChips.length > 0 ? h("div", { class: "chips" }, ...fileChips) : null,
		parts.editorContext
			? collapsible(ctx, `${item.id}:ctx`, ["editor context"], () => h("pre", { class: "out" }, parts.editorContext ?? ""), false, "aside")
			: null,
		item.imageCount ? h("div", { class: "meta" }, `+${item.imageCount} image${item.imageCount === 1 ? "" : "s"}`) : null,
	);
}

function lineCount(text: string): string {
	const lines = text.split("\n").length;
	return `${lines} line${lines === 1 ? "" : "s"}`;
}

// ── Attachments ──────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function setAttachments(next: Attachment[]): void {
	attachments = next;
	attachmentBar.replaceChildren(...attachments.map(renderAttachmentChip));
	attachmentBar.classList.toggle("hidden", attachments.length === 0);
	scheduleReport();
}

function renderAttachmentChip(attachment: Attachment): HTMLElement {
	const remove = h(
		"button",
		{
			class: "plain chip-remove",
			title: `Remove ${attachment.label}`,
			attrs: { "aria-label": `Remove ${attachment.label}` },
			onClick: () => setAttachments(attachments.filter(other => other.id !== attachment.id)),
		},
		"×",
	);
	switch (attachment.kind) {
		case "file":
			return h("span", { class: "chip file", title: attachment.path }, h("span", { class: "chip-label" }, attachment.label), remove);
		case "text":
			return h(
				"span",
				{ class: "chip text", title: attachment.text.slice(0, 500) },
				h("span", { class: "chip-label" }, `${attachment.label} · ${lineCount(attachment.text)}`),
				remove,
			);
		case "image":
			return h(
				"span",
				{ class: "chip image", title: attachment.label },
				h("img", { attrs: { src: `data:${attachment.mimeType};base64,${attachment.data}`, alt: "" } }),
				h("span", { class: "chip-label" }, attachment.label),
				remove,
			);
	}
}

function localNotice(level: "info" | "warning" | "error", text: string): void {
	upsertItem({ kind: "notice", id: `local-${++localNoticeSequence}`, level, text });
}

function addImageFiles(files: File[]): void {
	for (const file of files) {
		if (file.size > MAX_IMAGE_BYTES) {
			localNotice("warning", `Image ${file.name || "from clipboard"} is larger than 10 MB and was not attached.`);
			continue;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			const data = url.slice(url.indexOf(",") + 1);
			const label = file.name && file.name !== "image.png" ? file.name : `Image ${++imageSequence}`;
			setAttachments([...attachments, { id: crypto.randomUUID(), kind: "image", data, mimeType: file.type, label }]);
		};
		reader.onerror = () => localNotice("error", `Reading ${file.name || "the pasted image"} failed.`);
		reader.readAsDataURL(file);
	}
}

function imageFiles(transfer: DataTransfer | null): File[] {
	return Array.from(transfer?.files ?? []).filter(file => file.type.startsWith("image/"));
}

input.addEventListener("paste", event => {
	const images = imageFiles(event.clipboardData);
	if (images.length > 0) {
		event.preventDefault();
		addImageFiles(images);
		return;
	}
	const text = event.clipboardData?.getData("text/plain") ?? "";
	if (classifyPaste(text) === "inline") return;
	event.preventDefault();
	setAttachments([...attachments, { id: crypto.randomUUID(), kind: "text", text, label: `Pasted text ${++pastedTextSequence}` }]);
});

composer.addEventListener("dragover", event => {
	if (imageFiles(event.dataTransfer).length > 0 || event.dataTransfer?.types.includes("Files")) event.preventDefault();
});

composer.addEventListener("drop", event => {
	const images = imageFiles(event.dataTransfer);
	if (images.length === 0) return;
	event.preventDefault();
	addImageFiles(images);
});

function renderThinking(item: Extract<TranscriptItem, { kind: "assistant" }>): HTMLElement | null {
	if (!item.thinking) return null;
	const lines = item.thinking.split("\n").filter(line => line.trim()).length;
	const label = item.streaming && !item.text ? "thinking…" : `thinking · ${lines} line${lines === 1 ? "" : "s"}`;
	return collapsible(ctx, `${item.id}:thinking`, [label], () => h("div", { class: "thinking" }, item.thinking), false, "aside");
}

function renderAssistant(item: Extract<TranscriptItem, { kind: "assistant" }>): HTMLElement {
	const body = h("div", { class: "md" });
	body.innerHTML = renderMarkdown(item.text);
	const meta: string[] = [];
	if (!item.streaming) {
		if (item.model) meta.push(item.model);
		if (item.usage) meta.push(`${item.usage.input.toLocaleString()} in / ${item.usage.output.toLocaleString()} out`);
		if (item.usage?.costUsd !== undefined) meta.push(formatCost(item.usage.costUsd));
		if (item.stopReason && item.stopReason !== "stop" && item.stopReason !== "toolUse") meta.push(item.stopReason);
	}
	return h(
		"div",
		{ class: `item assistant${item.streaming ? " streaming" : ""}` },
		renderThinking(item),
		body,
		item.errorMessage ? h("div", { class: "notice level-error" }, item.errorMessage) : null,
		meta.length > 0 ? h("div", { class: "meta msg-meta" }, meta.join(" · ")) : null,
	);
}

function renderNotice(level: string, text: string): HTMLElement {
	const el = h("div", { class: `item notice level-${level}`, title: text });
	el.textContent = text;
	el.addEventListener("click", () => el.classList.toggle("expanded"));
	return el;
}

function renderItem(item: TranscriptItem): HTMLElement {
	let el: HTMLElement;
	try {
		switch (item.kind) {
			case "user":
				el = renderUser(item);
				break;
			case "assistant":
				el = renderAssistant(item);
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

/** Replaces only the node of the changed item (or appends a new one). */
function upsertItem(item: TranscriptItem): void {
	const el = renderItem(item);
	const previous = itemNodes.get(item.id);
	if (previous) previous.replaceWith(el);
	else column.insertBefore(el, emptyHint.isConnected ? emptyHint : null);
	itemNodes.set(item.id, el);
}

function updateEmptyHint(): void {
	if (itemNodes.size > 0) {
		emptyHint.remove();
		return;
	}
	const model = session.model?.name;
	emptyHint.textContent = unavailable ? "OMP is not available." : `${model ? `${model} · ` : ""}Enter to send · Shift+Enter for a new line`;
	if (!emptyHint.isConnected) column.append(emptyHint);
}

function afterTranscriptChange(): void {
	updateEmptyHint();
	followOutput();
}

// ── Session chrome ───────────────────────────────────────────────────────────

const TODO_GLYPH: Record<string, string> = { completed: "[x]", in_progress: "[>]", pending: "[ ]", abandoned: "[-]", blocked: "[!]" };

function renderTodos(): void {
	const summary = todoSummary(session.todos);
	if (!summary) {
		todosBox.replaceChildren();
		return;
	}
	todosBox.replaceChildren(
		collapsible(ctx, "todos", [h("span", { class: "todo-summary", title: summary }, summary)], () =>
			h(
				"div",
				{ class: "todo-list" },
				...session.todos.map(phase =>
					h(
						"div",
						{ class: "todo-phase" },
						h("div", { class: "todo-phase-name" }, phase.name),
						...phase.tasks.map(task => h("div", { class: `todo status-${task.status}` }, `${TODO_GLYPH[task.status] ?? "[?]"} ${task.content}`)),
					),
				),
			),
		),
	);
}

function renderQueue(): void {
	queueBox.replaceChildren(
		...session.queue.steering.map(text => h("span", { class: "queue-chip", title: text }, `steer: ${text}`)),
		...session.queue.followUp.map(text => h("span", { class: "queue-chip", title: text }, `follow-up: ${text}`)),
	);
}

function currentState() {
	return stateWord({ connection: connection.state, phase: session.phase, pendingInteractions: interactionNodes.size, unavailable: unavailable !== undefined });
}

function renderActivity(): void {
	const word = currentState();
	if (busySince !== undefined && word !== "offline" && word !== "starting") {
		activityLabel.textContent = `${session.isCompacting ? "compacting… " : ""}${elapsedText(Date.now() - busySince)}`;
	} else {
		activityLabel.textContent = session.isCompacting ? "compacting…" : "";
	}
}

function renderState(): void {
	const word = currentState();
	stateDot.className = `dot state-${word}`;
	stateLabel.textContent = word;
	stateLabel.title = `connection: ${connection.state}${connection.detail ? ` (${connection.detail})` : ""}`;
	renderActivity();
}

function trackBusy(): void {
	if (!isBusy()) {
		busySince = undefined;
		clearInterval(busyTimer);
		busyTimer = undefined;
		return;
	}
	busySince ??= Date.now();
	busyTimer ??= window.setInterval(renderActivity, 1000);
}

function renderSession(): void {
	trackBusy();
	renderState();
	const shortId = session.sessionId?.slice(0, 8);
	sessionButton.textContent = session.sessionName || shortId || "no session";
	sessionButton.title = `${session.sessionFile ?? "No session file yet"}\nClick to rename`;
	modelButton.textContent = `${session.model?.name ?? "select model"} ▾`;
	modelButton.title = session.model ? `${session.model.provider}/${session.model.id}\nClick to change the model` : "Select model";

	const effort = effortChoices(session);
	thinkingSelect.classList.toggle("hidden", effort.options.length === 0);
	const optionsKey = effort.options.map(option => `${option.value}=${option.label}`).join(",");
	if (thinkingSelect.dataset.options !== optionsKey) {
		thinkingSelect.dataset.options = optionsKey;
		thinkingSelect.replaceChildren(...effort.options.map(option => h("option", { attrs: { value: option.value } }, option.label)));
	}
	if (effort.value) thinkingSelect.value = effort.value;
	thinkingSelect.title =
		effort.value === "auto" ? `Reasoning effort: auto (OMP picks it per turn${session.thinkingLevel ? `, now ${session.thinkingLevel}` : ""})` : "Reasoning effort";

	const fast = session.fastModeEnabled === true;
	fastButton.classList.toggle("on", fast);
	fastButton.setAttribute("aria-pressed", String(fast));
	fastButton.title = fast ? `Fast mode on${session.fastModeActive ? " (active)" : ""}; click to turn off` : "Fast mode off; click to turn on";

	usageLabel.textContent = usageText(session);
	usageLabel.title = session.contextUsage
		? `${session.contextUsage.tokens.toLocaleString()} / ${session.contextUsage.contextWindow.toLocaleString()} context tokens`
		: "";

	statusLine.textContent = session.lastError ?? "";
	statusLine.title = session.lastError ?? "";

	const busy = isBusy();
	sendButton.textContent = busy ? "Steer" : "Send";
	sendButton.title = busy ? "Steer the running agent (Enter)" : "Send (Enter)";
	input.placeholder = busy ? "Steer the running agent, or queue a follow-up…" : "Ask OMP…";
	followUpButton.classList.toggle("hidden", !busy);
	stopButton.classList.toggle("hidden", !busy);
	const disabled = unavailable !== undefined;
	sendButton.disabled = disabled;
	input.disabled = disabled;

	renderQueue();
	renderTodos();
	updateEmptyHint();
}

function renderBanner(): void {
	if (!unavailable) {
		banner.className = "banner hidden";
		banner.replaceChildren();
		return;
	}
	banner.className = "banner";
	banner.replaceChildren(
		h("span", { class: "banner-text", title: unavailable }, `OMP not found: ${unavailable}`),
		h("button", { class: "secondary", onClick: command("omp.openSettings") }, "Open Settings"),
		h("button", { class: "secondary", onClick: command("omp.restart") }, "Retry"),
	);
}

// ── Interactions ─────────────────────────────────────────────────────────────

function respond(id: string, response: InteractionResponse): void {
	const el = interactionNodes.get(id);
	el?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button, input, textarea").forEach(control => (control.disabled = true));
	post({ type: "respond", id, response });
}

function actions(...buttons: HTMLElement[]): HTMLElement {
	return h("div", { class: "interaction-actions" }, ...buttons);
}

function cancelButton(id: string): HTMLElement {
	return h("button", { class: "secondary", onClick: () => respond(id, { kind: "cancelled" }) }, "Cancel");
}

function renderAsk(request: Extract<InteractionRequest, { kind: "ask" }>): HTMLElement[] {
	const readers: Array<() => AskQuestionState> = [];
	const fields = request.questions.map((question, qIndex) => {
		const name = `ask-${request.id}-${qIndex}`;
		const type = question.multi ? "checkbox" : "radio";
		const optionInputs = question.options.map(option => {
			const control = h("input", { attrs: { type, name, value: option.label } });
			return { option, control };
		});
		const other = h("input", { class: "text", attrs: { type: "text", placeholder: "Other…", "aria-label": `${question.question} — other` } });
		if (!question.multi) {
			other.addEventListener("input", () => {
				if (other.value.trim()) optionInputs.forEach(({ control }) => (control.checked = false));
			});
			optionInputs.forEach(({ control }) => control.addEventListener("change", () => (other.value = "")));
		}
		readers.push(() => ({ selected: optionInputs.filter(({ control }) => control.checked).map(({ option }) => option.label), custom: other.value }));
		return h(
			"fieldset",
			{ class: "ask-question" },
			h("legend", undefined, question.header ? `${question.header}: ${question.question}` : question.question),
			...optionInputs.map(({ option, control }, oIndex) =>
				h(
					"label",
					{ class: "ask-option" },
					control,
					h("span", undefined, option.label),
					question.recommended === oIndex ? h("span", { class: "meta" }, " (recommended)") : null,
					option.description ? h("span", { class: "meta" }, ` — ${option.description}`) : null,
				),
			),
			other,
		);
	});
	return [
		...fields,
		actions(
			h("button", { class: "primary", onClick: () => respond(request.id, { kind: "answers", answers: buildAskAnswers(request.questions, readers.map(read => read())) }) }, "Submit"),
			cancelButton(request.id),
		),
	];
}

function renderInteraction(pending: PendingInteraction): HTMLElement {
	const { request } = pending;
	const title = request.kind === "ask" ? (request.questions.length === 1 ? "Question" : `${request.questions.length} questions`) : request.title;
	const countdown = h("span", { class: "countdown meta" });
	const body: HTMLElement[] = [];
	switch (request.kind) {
		case "confirm":
			if (request.message) body.push(h("div", { class: "text" }, request.message));
			body.push(
				actions(
					h("button", { class: "primary", onClick: () => respond(request.id, { kind: "confirmed", confirmed: true }) }, "Approve"),
					h("button", { class: "secondary", onClick: () => respond(request.id, { kind: "confirmed", confirmed: false }) }, "Deny"),
				),
			);
			break;
		case "select":
			body.push(
				h(
					"div",
					{ class: "select-options" },
					...request.options.map(option =>
						h(
							"button",
							{ class: "option", title: option.description ?? option.label, onClick: () => respond(request.id, { kind: "value", value: option.label }) },
							h("span", undefined, option.label),
							option.description ? h("span", { class: "meta" }, option.description) : null,
						),
					),
				),
				actions(cancelButton(request.id)),
			);
			break;
		case "input": {
			const field = h("input", {
				class: "text",
				attrs: { type: request.secret ? "password" : "text", placeholder: request.placeholder ?? "", autocomplete: "off", "aria-label": request.title },
			});
			const submitValue = () => {
				const value = field.value;
				field.value = "";
				respond(request.id, { kind: "value", value });
			};
			field.addEventListener("keydown", event => {
				if (event.key === "Enter" && !event.isComposing) {
					event.preventDefault();
					submitValue();
				}
			});
			body.push(field, actions(h("button", { class: "primary", onClick: submitValue }, "Submit"), cancelButton(request.id)));
			break;
		}
		case "editor": {
			const area = h("textarea", { class: "input", attrs: { rows: "6", "aria-label": request.title } });
			area.value = request.prefill ?? "";
			body.push(area, actions(h("button", { class: "primary", onClick: () => respond(request.id, { kind: "value", value: area.value }) }, "Submit"), cancelButton(request.id)));
			break;
		}
		case "ask":
			body.push(...renderAsk(request));
			break;
	}
	return h(
		"div",
		{ class: `interaction kind-${request.kind}`, attrs: { "data-id": request.id } },
		h("div", { class: "interaction-title" }, h("span", undefined, title), h("span", { class: "spacer" }), countdown),
		...body,
	);
}

function tickCountdowns(): void {
	const now = Date.now();
	for (const [id, expiresAt] of expiries) {
		const el = interactionNodes.get(id)?.querySelector(".countdown");
		if (el) el.textContent = `${Math.max(0, Math.ceil((expiresAt - now) / 1000))}s left`;
	}
	if (expiries.size === 0) {
		clearInterval(countdownTimer);
		countdownTimer = undefined;
	}
}

function addInteraction(pending: PendingInteraction): void {
	const el = renderInteraction(pending);
	interactionNodes.get(pending.request.id)?.remove();
	interactionNodes.set(pending.request.id, el);
	interactionsBox.append(el);
	if (pending.expiresAt) {
		expiries.set(pending.request.id, pending.expiresAt);
		tickCountdowns();
		countdownTimer ??= window.setInterval(tickCountdowns, 1000);
	}
	renderState();
}

function removeInteraction(id: string): void {
	interactionNodes.get(id)?.remove();
	interactionNodes.delete(id);
	expiries.delete(id);
	renderState();
}

// ── Messages ─────────────────────────────────────────────────────────────────

let reportScheduled = false;

function report(): void {
	reportScheduled = false;
	const counts: Record<string, number> = {};
	for (const el of itemNodes.values()) {
		const kind = el.dataset.kind;
		if (kind && el.isConnected) counts[kind] = (counts[kind] ?? 0) + 1;
	}
	const assistants = column.querySelectorAll<HTMLElement>('[data-kind="assistant"] > .md');
	const lastAssistantText = assistants.length > 0 ? (assistants[assistants.length - 1].textContent ?? "") : undefined;
	const collapsedTools = column.querySelectorAll('[data-kind="tool"] > details:not([open])').length;
	post({
		type: "rendered",
		counts,
		lastAssistantText,
		interactions: [...interactionNodes.keys()],
		collapsedTools,
		attachments: attachments.map(attachment => attachment.label),
	});
}

function scheduleReport(): void {
	if (reportScheduled) return;
	reportScheduled = true;
	setTimeout(report, 0);
}

function handle(message: HostMessage): void {
	switch (message.type) {
		case "reset":
			session = message.session;
			ctx.cwd = message.cwd;
			connection = message.connection;
			unavailable = message.unavailable;
			if (!contextToggleInitialized) {
				contextToggle.checked = saved.includeContext ?? message.includeEditorContext;
				contextToggleInitialized = true;
			}
			itemNodes.clear();
			column.replaceChildren();
			message.items.forEach(upsertItem);
			for (const id of [...interactionNodes.keys()]) removeInteraction(id);
			message.interactions.forEach(addInteraction);
			renderBanner();
			renderSession();
			stickToBottom = true;
			afterTranscriptChange();
			break;
		case "item":
			upsertItem(message.item);
			afterTranscriptChange();
			break;
		case "session":
			session = message.session;
			renderSession();
			break;
		case "connection":
			connection = message.connection;
			renderState();
			break;
		case "interaction":
			addInteraction(message.pending);
			break;
		case "interactionClosed":
			removeInteraction(message.id);
			break;
		case "notice":
			upsertItem({ kind: "notice", id: `local-${++localNoticeSequence}`, level: message.level, text: message.text });
			afterTranscriptChange();
			break;
		case "setComposer":
			input.value = message.text;
			autosize();
			saveState();
			input.focus();
			break;
		case "focusComposer":
			input.focus();
			break;
		case "addAttachments": {
			const known = new Set(attachments.flatMap(attachment => (attachment.kind === "file" ? [attachment.path] : [])));
			setAttachments([...attachments, ...message.attachments.filter(attachment => attachment.kind !== "file" || !known.has(attachment.path))]);
			input.focus();
			break;
		}
	}
	scheduleReport();
}

window.addEventListener("message", (event: MessageEvent<HostMessage>) => handle(event.data));
saveState();
autosize();
renderSession();
post({ type: "ready" });
