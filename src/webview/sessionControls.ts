import type { ModelView, SessionView } from "../omp/api";
import { effortChoices } from "../shared/session";
import { usageText } from "./chrome";
import { h } from "./dom";
import { icon, ringMeter } from "./icons";
import type { WebviewMessage } from "./protocol";

/** Model, reasoning effort, fast mode and context usage controls in the composer row. */
export class SessionControls {
	readonly modelPill: HTMLElement;
	readonly fastButton: HTMLButtonElement;
	readonly usage: HTMLElement;
	readonly #modelButton: HTMLButtonElement;
	readonly #thinkingSelect: HTMLSelectElement;
	readonly #thinkingBox: HTMLElement;
	readonly #usageRing = ringMeter();
	readonly #usageValue = h("span", { class: "usage-text" });
	#model: ModelView | undefined;
	/** The tier router picks the model for each turn. */
	#tierAuto = false;

	constructor(post: (message: WebviewMessage) => void) {
		this.#modelButton = h("button", { class: "model", title: "Select model", onClick: () => post({ type: "command", command: "omp.selectModel" }) });
		this.#thinkingSelect = h("select", { class: "thinking-select", title: "Reasoning effort", attrs: { "aria-label": "Reasoning effort" } });
		this.#thinkingSelect.addEventListener("change", () => post({ type: "setThinkingLevel", level: this.#thinkingSelect.value }));
		this.#thinkingBox = h("span", { class: "thinking-box" }, this.#thinkingSelect, icon("chevronDown", 12));
		this.modelPill = h("span", { class: "model-pill" }, this.#modelButton, this.#thinkingBox);
		this.fastButton = h(
			"button",
			{
				class: "icon-button toggle fast",
				attrs: { "aria-label": "Fast mode", "aria-pressed": "false" },
				onClick: () => post({ type: "command", command: "omp.toggleFastMode" }),
			},
			icon("zap"),
		);
		this.usage = h("span", { class: "usage hidden" }, this.#usageRing.svg, this.#usageValue);
	}

	/** Marks the model `· tier auto` while the tier router chooses it. */
	setTierAuto(tierAuto: boolean): void {
		this.#tierAuto = tierAuto;
		this.#renderModel();
	}

	render(session: SessionView): void {
		this.#model = session.model;
		this.#renderModel();

		const effort = effortChoices(session);
		this.#thinkingBox.classList.toggle("hidden", effort.options.length === 0);
		const optionsKey = effort.options.map(option => `${option.value}=${option.label}`).join(",");
		if (this.#thinkingSelect.dataset.options !== optionsKey) {
			this.#thinkingSelect.dataset.options = optionsKey;
			this.#thinkingSelect.replaceChildren(...effort.options.map(option => h("option", { attrs: { value: option.value } }, option.label)));
		}
		if (effort.value) this.#thinkingSelect.value = effort.value;
		this.#thinkingSelect.title =
			effort.value === "auto" ? `Reasoning effort: auto (OMP picks it per turn${session.thinkingLevel ? `, now ${session.thinkingLevel}` : ""})` : "Reasoning effort";

		const fast = session.fastModeEnabled === true;
		this.fastButton.setAttribute("aria-pressed", String(fast));
		this.fastButton.title = fast ? `Fast mode on${session.fastModeActive ? " (active)" : ""}; click to turn off` : "Fast mode off; click to turn on";

		const usage = usageText(session);
		const percent = session.contextUsage ? Math.min(100, Math.max(0, Math.round(session.contextUsage.percent))) : undefined;
		this.usage.classList.toggle("hidden", usage === "");
		this.usage.classList.toggle("high", percent !== undefined && percent >= 80);
		this.#usageRing.svg.classList.toggle("hidden", percent === undefined);
		this.#usageRing.arc.setAttribute("stroke-dasharray", `${percent ?? 0} 100`);
		this.#usageValue.textContent = percent !== undefined ? `${percent}%` : usage;
		this.usage.title = session.contextUsage
			? `${usage}\n${session.contextUsage.tokens.toLocaleString()} / ${session.contextUsage.contextWindow.toLocaleString()} context tokens`
			: usage;
	}

	#renderModel(): void {
		const model = this.#model;
		this.#modelButton.textContent = model ? `${model.name}${this.#tierAuto ? " · tier auto" : ""}` : "Select model";
		this.#modelButton.title = model
			? `${model.provider}/${model.id}${this.#tierAuto ? "\nThe tier router picks the model for each turn" : ""}\nClick to change the model`
			: "Select model";
	}
}
