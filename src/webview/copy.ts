import { errorMessage } from "../shared/errors";
import { h } from "./dom";
import { icon } from "./icons";

/** How long a button shows `Copied` before it returns to its label. */
const COPIED_MS = 1500;

function showState(button: HTMLElement, state: "copied" | "failed" | undefined, title: string): void {
	if (state) button.dataset.copyState = state;
	else delete button.dataset.copyState;
	button.title = title;
	button.setAttribute("aria-label", title);
}

/**
 * Writes `text` to the clipboard and shows the outcome on `button`: `Copied` for a moment, or why copying
 * failed until the next attempt. The button's label is taken from its `aria-label` on the first copy.
 */
export async function copyText(text: string, button: HTMLElement): Promise<void> {
	const label = button.dataset.copyLabel ?? button.getAttribute("aria-label") ?? "Copy";
	button.dataset.copyLabel = label;
	try {
		await navigator.clipboard.writeText(text);
	} catch (error) {
		showState(button, "failed", `Copy failed: ${errorMessage(error)}`);
		return;
	}
	showState(button, "copied", "Copied");
	setTimeout(() => {
		if (button.dataset.copyState === "copied") showState(button, undefined, label);
	}, COPIED_MS);
}

/** Icon button labelled `label` that copies what `text` returns when clicked. */
export function copyButton(text: () => string, label: string): HTMLButtonElement {
	const button = h("button", {
		class: "copy-button",
		title: label,
		attrs: { type: "button", "aria-label": label },
		onClick: () => void copyText(text(), button),
	});
	button.append(icon("copy", 14));
	return button;
}
