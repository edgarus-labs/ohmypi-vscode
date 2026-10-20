import type { InteractionRequest, InteractionResponse } from "../omp/api";
import { type AskQuestionState, buildAskAnswers } from "./ask";
import { h } from "./dom";
import type { PendingInteraction, WebviewMessage } from "./protocol";

type Respond = (id: string, response: InteractionResponse) => void;

function actions(...buttons: HTMLElement[]): HTMLElement {
	return h("div", { class: "interaction-actions" }, ...buttons);
}

function cancelButton(id: string, respond: Respond): HTMLElement {
	return h("button", { class: "secondary", onClick: () => respond(id, { kind: "cancelled" }) }, "Cancel");
}

function renderAsk(request: Extract<InteractionRequest, { kind: "ask" }>, respond: Respond): HTMLElement[] {
	const readers: Array<() => AskQuestionState> = [];
	const fields = request.questions.map((question, qIndex) => {
		const name = `ask-${request.id}-${qIndex}`;
		const type = question.multi ? "checkbox" : "radio";
		const optionInputs = question.options.map(option => ({ option, control: h("input", { attrs: { type, name, value: option.label } }) }));
		const other = h("input", { class: "text", attrs: { type: "text", placeholder: "Other…", "aria-label": `${question.question} — other` } });
		if (!question.multi) {
			other.addEventListener("input", () => {
				if (other.value.trim()) for (const { control } of optionInputs) control.checked = false;
			});
			for (const { control } of optionInputs) control.addEventListener("change", () => (other.value = ""));
		}
		other.addEventListener("keydown", event => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				submit();
			}
		});
		readers.push(() => ({ selected: optionInputs.filter(({ control }) => control.checked).map(({ option }) => option.label), custom: other.value }));
		return h(
			"fieldset",
			{ class: "ask-question" },
			h("legend", undefined, question.header ? `${question.header}: ${question.question}` : question.question),
			...optionInputs.map(({ option, control }, oIndex) =>
				h(
					"label",
					{ class: "ask-option", title: option.preview },
					control,
					h(
						"span",
						{ class: "ask-option-text" },
						h("span", { class: "ask-option-label" }, option.label),
						question.recommended === oIndex ? h("span", { class: "ask-recommended" }, "recommended") : null,
						option.description ? h("span", { class: "meta ask-option-description" }, option.description) : null,
					),
				),
			),
			other,
		);
	});
	const submit = () => respond(request.id, { kind: "answers", answers: buildAskAnswers(request.questions, readers.map(read => read())) });
	return [...fields, actions(h("button", { class: "primary", onClick: submit }, "Submit"), cancelButton(request.id, respond))];
}

function renderBody(request: InteractionRequest, respond: Respond): HTMLElement[] {
	switch (request.kind) {
		case "confirm":
			return [
				...(request.message ? [h("div", { class: "text" }, request.message)] : []),
				actions(
					h("button", { class: "primary", onClick: () => respond(request.id, { kind: "confirmed", confirmed: true }) }, "Approve"),
					h("button", { class: "secondary", onClick: () => respond(request.id, { kind: "confirmed", confirmed: false }) }, "Deny"),
				),
			];
		case "select":
			return [
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
				actions(cancelButton(request.id, respond)),
			];
		case "input": {
			const field = h("input", {
				class: "text",
				attrs: { type: "text", placeholder: request.placeholder ?? "", autocomplete: "off", "aria-label": request.title },
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
			return [field, actions(h("button", { class: "primary", onClick: submitValue }, "Submit"), cancelButton(request.id, respond))];
		}
		case "editor": {
			const area = h("textarea", { class: "input", attrs: { rows: "6", "aria-label": request.title } });
			area.value = request.prefill ?? "";
			return [area, actions(h("button", { class: "primary", onClick: () => respond(request.id, { kind: "value", value: area.value }) }, "Submit"), cancelButton(request.id, respond))];
		}
		case "ask":
			return renderAsk(request, respond);
	}
}

export interface InteractionsDeps {
	post(message: WebviewMessage): void;
	/** Reads `text` out through the screen-reader live region. */
	announce(text: string): void;
	/** Whether the user is typing in the composer (a new card must not steal focus then). */
	composerHasFocus(): boolean;
	focusComposer(): void;
}

/**
 * Pending OMP questions (confirm, select, input, editor, ask) as labelled cards above the composer, with
 * timeout countdowns. A new card is announced and focused unless the user is typing; answering returns
 * focus to the composer.
 */
export class InteractionsView {
	readonly element = h("div", { class: "interactions" });
	readonly #deps: InteractionsDeps;
	readonly #nodes = new Map<string, HTMLElement>();
	readonly #expiries = new Map<string, number>();
	#countdownTimer: number | undefined;
	#titleSequence = 0;

	constructor(deps: InteractionsDeps) {
		this.#deps = deps;
	}

	get size(): number {
		return this.#nodes.size;
	}

	ids(): string[] {
		return [...this.#nodes.keys()];
	}

	add(pending: PendingInteraction): void {
		const { request } = pending;
		const title = request.kind === "ask" ? (request.questions.length === 1 ? "Question" : `${request.questions.length} questions`) : request.title;
		const titleId = `interaction-title-${++this.#titleSequence}`;
		const el = h(
			"div",
			{ class: `interaction kind-${request.kind}`, attrs: { "data-id": request.id, role: "region", "aria-labelledby": titleId } },
			h("div", { class: "interaction-title" }, h("span", { attrs: { id: titleId } }, title), h("span", { class: "spacer" }), h("span", { class: "countdown meta" })),
			...renderBody(request, (id, response) => this.#respond(id, response)),
		);
		this.#nodes.get(request.id)?.remove();
		this.#nodes.set(request.id, el);
		this.element.append(el);
		this.#deps.announce(`OMP asks: ${title}`);
		if (!this.#deps.composerHasFocus()) el.querySelector<HTMLElement>("button, input, textarea")?.focus();
		if (pending.expiresAt) {
			this.#expiries.set(request.id, pending.expiresAt);
			this.#tick();
			this.#countdownTimer ??= window.setInterval(() => this.#tick(), 1000);
		}
	}

	remove(id: string): void {
		this.#nodes.get(id)?.remove();
		this.#nodes.delete(id);
		this.#expiries.delete(id);
	}

	clear(): void {
		for (const id of this.ids()) this.remove(id);
	}

	#respond(id: string, response: InteractionResponse): void {
		const el = this.#nodes.get(id);
		this.#deps.focusComposer();
		for (const control of el?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button, input, textarea") ?? []) control.disabled = true;
		this.#deps.post({ type: "respond", id, response });
	}

	#tick(): void {
		const now = Date.now();
		for (const [id, expiresAt] of this.#expiries) {
			const el = this.#nodes.get(id)?.querySelector(".countdown");
			if (el) el.textContent = `${Math.max(0, Math.ceil((expiresAt - now) / 1000))}s left`;
		}
		if (this.#expiries.size === 0) {
			window.clearInterval(this.#countdownTimer);
			this.#countdownTimer = undefined;
		}
	}
}
