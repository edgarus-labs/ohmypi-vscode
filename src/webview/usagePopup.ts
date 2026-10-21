import type { ProviderUsage, UsageLimit } from "../omp/api";
import { h } from "./dom";
import { icon } from "./icons";
import type { UsageResult, WebviewMessage } from "./protocol";

/** Theme chart colors a provider's marker and bars take, picked by the provider id. */
const PROVIDER_COLORS = ["blue", "green", "orange", "purple", "yellow", "red"].map(name => `var(--vscode-charts-${name})`);

function providerColor(provider: string): string {
	const id = provider.toLowerCase().replace(/ /g, "-");
	let sum = 0;
	for (let i = 0; i < id.length; i++) sum = (sum * 31 + id.charCodeAt(i)) >>> 0;
	return PROVIDER_COLORS[sum % PROVIDER_COLORS.length];
}

/** `85.25`, `4`: the used share with at most two decimals. */
function preciseShare(percent: number): string {
	return String(Math.round(percent * 100) / 100);
}

function limitRow(limit: UsageLimit): HTMLElement {
	const used = Math.round(limit.usedPercent);
	const level = limit.usedPercent >= 100 ? "error" : limit.usedPercent >= 80 ? "warning" : undefined;
	const fill = h("span", { class: "usage-limit-fill" });
	fill.style.width = `${Math.min(100, Math.max(0, limit.usedPercent))}%`;
	const tooltip = [
		limit.name,
		limit.account,
		`${preciseShare(limit.usedPercent)}% used`,
		...(limit.resets ? [`Resets ${limit.resets}`] : []),
		...(limit.inUse ? ["Used by this session"] : []),
	].join("\n");
	return h(
		"div",
		{
			class: ["usage-limit", limit.inUse ? "in-use" : "", level ?? ""].filter(Boolean).join(" "),
			title: tooltip,
			attrs: { role: "listitem", "aria-label": `${limit.name} ${used}% used` },
		},
		h("span", { class: "usage-limit-name" }, limit.name),
		h("span", { class: "usage-limit-bar" }, fill),
		h("span", { class: "usage-limit-percent" }, `${used}%`),
		h("span", { class: "usage-limit-resets" }, limit.resets ?? ""),
	);
}

function providerSection(provider: ProviderUsage): HTMLElement {
	const section = h(
		"div",
		{ class: "usage-provider" },
		h(
			"div",
			{ class: "usage-provider-heading" },
			h("span", { class: "usage-provider-marker", attrs: { "aria-hidden": "true" } }),
			h("span", { class: "usage-provider-name" }, provider.provider),
		),
		h("div", { class: "usage-limits", attrs: { role: "list", "aria-label": provider.provider } }, ...provider.limits.map(limitRow)),
	);
	section.style.setProperty("--provider-color", providerColor(provider.provider));
	return section;
}

/**
 * Rate limits per provider in a popup over the transcript, from OMP's `/usage`. Every open and every Refresh
 * reloads; a Refresh while loading is ignored, and a result for an earlier request is dropped. Escape, Close
 * or a click beside it closes it and returns focus to the input.
 */
export class UsagePopup {
	readonly #overlay: HTMLElement;
	readonly #panel: HTMLElement;
	readonly #body = h("div", { class: "usage-popup-body" });
	readonly #host: HTMLElement;
	readonly #post: (message: WebviewMessage) => void;
	readonly #onClose: () => void;
	#open = false;
	/** Id of the request whose answer the popup waits for. */
	#loading: string | undefined;
	#sequence = 0;

	/** Shows inside `host` (the transcript area); `onClose` returns focus to the input. */
	constructor(host: HTMLElement, post: (message: WebviewMessage) => void, onClose: () => void) {
		this.#host = host;
		this.#post = post;
		this.#onClose = onClose;
		this.#panel = h(
			"div",
			{ class: "usage-popup", attrs: { role: "dialog", "aria-label": "Usage", tabindex: "-1" } },
			h(
				"div",
				{ class: "usage-popup-bar" },
				h("span", { class: "usage-popup-title" }, "Usage"),
				h("span", { class: "spacer" }),
				h(
					"button",
					{ class: "icon-button usage-popup-refresh", title: "Refresh", attrs: { "aria-label": "Refresh usage" }, onClick: () => this.#load() },
					icon("refresh", 14),
				),
				h(
					"button",
					{ class: "icon-button usage-popup-close", title: "Close (Esc)", attrs: { "aria-label": "Close usage" }, onClick: () => this.close() },
					icon("x", 14),
				),
			),
			this.#body,
		);
		this.#overlay = h("div", { class: "usage-overlay" }, h("div", { class: "usage-scrim", onClick: () => this.close() }), this.#panel);
		this.#overlay.addEventListener("keydown", event => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			this.close();
		});
	}

	toggle(): void {
		if (!this.close()) this.#show();
	}

	/** Closes the popup and returns focus to the input; false when it was not open. */
	close(): boolean {
		if (!this.#open) return false;
		this.#open = false;
		this.#loading = undefined;
		this.#overlay.remove();
		this.#onClose();
		return true;
	}

	/** Shows the answer to the request the popup waits for; any other answer is dropped. */
	handleResult(result: UsageResult): void {
		if (!this.#open || result.id !== this.#loading) return;
		this.#loading = undefined;
		if ("error" in result) {
			this.#message(`Usage is unavailable: ${result.error}`);
			return;
		}
		const providers = result.providers.filter(provider => provider.limits.length > 0);
		if (providers.length === 0) this.#message("No provider reports usage limits.");
		else this.#body.replaceChildren(...providers.map(providerSection));
	}

	#show(): void {
		this.#open = true;
		this.#host.append(this.#overlay);
		this.#panel.focus();
		this.#load();
	}

	#load(): void {
		if (this.#loading !== undefined) return;
		this.#loading = `usage-${++this.#sequence}`;
		this.#message("Loading usage…");
		this.#post({ type: "loadUsage", id: this.#loading });
	}

	#message(text: string): void {
		this.#body.replaceChildren(h("div", { class: "usage-popup-message" }, text));
	}
}
