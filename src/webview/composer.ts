import type { PromptMode, SlashCommandView } from "../omp/api";
import { admitImages, classifyPaste, mergeAttachments } from "./attachments";
import { composerAction, lineCount } from "./chrome";
import { h } from "./dom";
import { icon } from "./icons";
import type { Attachment, SendResult, WebviewMessage } from "./protocol";
import { SlashPopup } from "./slashPopup";
import type { PersistedState } from "./state";

/** Keys that move the caret without editing; the `/` autocomplete follows the caret. */
const CARET_KEYS: Partial<Record<string, true>> = { ArrowLeft: true, ArrowRight: true, Home: true, End: true };

export interface ComposerDeps {
	post(message: WebviewMessage): void;
	state: PersistedState;
	/** Shows a notice in the transcript. */
	notice(level: "info" | "warning" | "error", text: string): void;
	/** Called after a prompt was posted to the host. */
	onSubmit(): void;
	/** Called whenever the attachments change. */
	onAttachmentsChange(): void;
	/** Closes a popup shown over the chat; true when one was open, so Escape does not also stop the turn. */
	closePopup?(): boolean;
}

/** Controls placed in the composer row between the add button and the editor-context toggle / usage meter. */
export interface ComposerRowControls {
	modelPill: HTMLElement;
	fastButton: HTMLElement;
	usage: HTMLElement;
}

function imageFiles(transfer: DataTransfer | null): File[] {
	return Array.from(transfer?.files ?? []).filter(file => file.type.startsWith("image/"));
}

/** Bytes of a base64 payload. */
function base64Bytes(data: string): number {
	return Math.floor((data.length * 3) / 4);
}

/** A prompt posted to the host and not yet confirmed by `sendResult`. */
interface PendingSend {
	id: string;
	text: string;
	attachmentIds: ReadonlySet<string>;
}

/**
 * Prompt input with attachments, the editor-context toggle, `/` command autocomplete and the send / steer / stop / follow-up actions.
 * A posted prompt stays in the composer until the host confirms it; image chips preview through object URLs.
 */
export class Composer {
	readonly element: HTMLElement;
	readonly input = h("textarea", { class: "input", attrs: { rows: "2", "aria-label": "Prompt" } });
	readonly #deps: ComposerDeps;
	readonly #attachmentBar = h("div", { class: "attachments hidden" });
	readonly #contextButton: HTMLButtonElement;
	readonly #followUpButton: HTMLButtonElement;
	readonly #sendButton: HTMLButtonElement;
	readonly #slash: SlashPopup;
	#attachments: Attachment[] = [];
	readonly #chips = new Map<string, HTMLElement>();
	/** Object URLs of image chip previews by attachment id; revoked when the chip goes. */
	readonly #previewUrls = new Map<string, string>();
	/** Images whose bytes are still being read. */
	readonly #reading = { count: 0, bytes: 0 };
	#pending: PendingSend | undefined;
	/** Highest "Pasted text N" number given out, counting those of the draft restored after a reload. */
	#pastedTextSequence = 0;
	#imageSequence = 0;
	#busy = false;
	#unavailable = false;

	constructor(deps: ComposerDeps, controls: ComposerRowControls) {
		this.#deps = deps;
		const addContextButton = h(
			"button",
			{
				class: "icon-button",
				title: "Add files to the chat (open editors, workspace)",
				attrs: { "aria-label": "Add files" },
				onClick: () => deps.post({ type: "pickContext" }),
			},
			icon("plus"),
		);
		this.#contextButton = h(
			"button",
			{
				class: "icon-button toggle context",
				attrs: { "aria-label": "Attach editor context", "aria-pressed": "false" },
				onClick: () => {
					deps.state.toggleIncludeContext();
					this.renderContextToggle();
				},
			},
			icon("fileCode"),
		);
		this.#followUpButton = h(
			"button",
			{ class: "secondary follow-up hidden", title: "Queue as follow-up after the current turn (Alt+Enter)", onClick: () => this.submit("followUp") },
			"Follow-up",
		);
		this.#sendButton = h("button", {
			class: "send",
			onClick: () => {
				if (composerAction({ busy: this.#busy, hasContent: this.#hasContent() }) === "stop") deps.post({ type: "abort" });
				else this.submit(this.#busy ? "steer" : "auto");
			},
		});
		this.#slash = new SlashPopup(this.input, () => this.#edited());
		this.element = h(
			"div",
			{ class: "composer" },
			this.#slash.element,
			this.#attachmentBar,
			this.input,
			h(
				"div",
				{ class: "composer-row" },
				addContextButton,
				controls.modelPill,
				controls.fastButton,
				this.#contextButton,
				h("span", { class: "spacer" }),
				controls.usage,
				this.#followUpButton,
				this.#sendButton,
			),
		);
		this.input.value = deps.state.draft;
		this.input.addEventListener("input", () => {
			this.#edited();
			this.#slash.refresh();
		});
		this.input.addEventListener("click", () => this.#slash.refresh());
		this.input.addEventListener("keyup", event => {
			if (CARET_KEYS[event.key]) this.#slash.refresh();
		});
		this.input.addEventListener("blur", () => this.#slash.close());
		this.input.addEventListener("keydown", event => {
			if (event.isComposing) return;
			if (this.#slash.handleKey(event)) {
				event.preventDefault();
				return;
			}
			if (event.key === "Escape") {
				if (deps.closePopup?.()) event.preventDefault();
				else if (this.#busy) {
					event.preventDefault();
					deps.post({ type: "abort" });
				}
				return;
			}
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				if (event.altKey) this.submit(this.#busy ? "followUp" : "auto");
				else this.submit(this.#busy ? "steer" : "auto");
			}
		});
		this.input.addEventListener("paste", event => this.#paste(event));
		this.element.addEventListener("dragover", event => {
			if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
		});
		this.element.addEventListener("drop", event => this.#drop(event));
		window.addEventListener("resize", () => this.autosize());
		const restored = [...deps.state.attachments];
		for (const attachment of restored) {
			const number = attachment.kind === "text" ? /^Pasted text (\d+)$/.exec(attachment.label)?.[1] : undefined;
			if (number) this.#pastedTextSequence = Math.max(this.#pastedTextSequence, Number(number));
		}
		this.#setAttachments(restored);
	}

	/** Labels of the attached chips. */
	get attachmentLabels(): string[] {
		return this.#attachments.map(attachment => attachment.label);
	}

	/** Commands the `/` autocomplete offers, in OMP order. */
	setCommands(commands: readonly SlashCommandView[]): void {
		this.#slash.setCommands(commands);
	}

	setStatus(status: { busy: boolean; unavailable: boolean }): void {
		this.#busy = status.busy;
		this.#unavailable = status.unavailable;
		this.input.placeholder = status.busy
			? "Steer the running turn…  (Enter to steer, Alt+Enter to queue a follow-up, Esc to stop)"
			: "Ask OMP…  (Enter to send, Shift+Enter for a new line)";
		this.input.disabled = status.unavailable;
		this.#renderActions();
		this.renderContextToggle();
	}

	renderContextToggle(): void {
		const on = this.#deps.state.includeContext;
		this.#contextButton.setAttribute("aria-pressed", String(on));
		this.#contextButton.title = `Editor context ${on ? "on" : "off"}: active file, selection, open editors, diagnostics`;
	}

	/** Replaces the draft (host `setComposer`). */
	setText(text: string): void {
		this.input.value = text;
		this.#edited();
		this.input.focus();
		this.#slash.refresh();
	}

	addAttachments(attachments: readonly Attachment[]): void {
		this.#setAttachments(mergeAttachments(this.#attachments, attachments));
		this.input.focus();
	}

	/** Posts the draft; ignored while the previous prompt still waits for the host's `sendResult` or images are still being read. */
	submit(mode: PromptMode): void {
		if (this.#pending || this.#reading.count > 0 || !this.#hasContent() || this.#unavailable) return;
		this.#slash.close();
		const text = this.input.value;
		const id = crypto.randomUUID();
		this.#pending = { id, text, attachmentIds: new Set(this.#attachments.map(attachment => attachment.id)) };
		this.#deps.post({ type: "send", id, text, mode, includeContext: this.#deps.state.includeContext, attachments: this.#attachments });
		this.#renderActions();
		this.#deps.onSubmit();
	}

	/** Clears what was sent once the host accepted it; otherwise keeps the draft and says why it was not sent. */
	handleSendResult(result: SendResult): void {
		const pending = this.#pending;
		if (!pending || pending.id !== result.id) return;
		this.#pending = undefined;
		if (!result.ok) {
			this.#deps.notice("error", `Prompt not sent: ${result.error ?? "the extension gave no reason"}`);
			this.#renderActions();
			return;
		}
		if (this.input.value === pending.text) {
			this.input.value = "";
			this.autosize();
			this.#deps.state.setDraft("");
			this.#slash.close();
		}
		this.#setAttachments(this.#attachments.filter(attachment => !pending.attachmentIds.has(attachment.id)));
	}

	/** Grows the input with its content between two rows and 40% of the panel height. */
	autosize(): void {
		this.input.style.height = "auto";
		const max = Math.max(48, Math.floor(window.innerHeight * 0.4));
		const wanted = this.input.scrollHeight + 2;
		this.input.style.height = `${Math.min(wanted, max)}px`;
		this.input.style.overflowY = wanted > max ? "auto" : "hidden";
	}

	/** Follows a change of the input text: size, saved draft and actions. */
	#edited(): void {
		this.autosize();
		this.#deps.state.setDraft(this.input.value);
		this.#renderActions();
	}

	#hasContent(): boolean {
		return this.input.value.trim() !== "" || this.#attachments.length > 0;
	}

	/** Swaps the round button between send/steer (arrow) and stop (square) and shows Follow-up while busy with content. */
	#renderActions(): void {
		const action = composerAction({ busy: this.#busy, hasContent: this.#hasContent() });
		const label = action === "stop" ? "Stop" : action === "steer" ? "Steer" : "Send";
		if (this.#sendButton.dataset.action !== action) {
			this.#sendButton.dataset.action = action;
			this.#sendButton.replaceChildren(icon(action === "stop" ? "stop" : "arrowUp", action === "stop" ? 14 : 16));
		}
		this.#sendButton.setAttribute("aria-label", label);
		this.#sendButton.title = action === "stop" ? "Abort the current turn (Esc)" : action === "steer" ? "Steer the running agent (Enter)" : "Send (Enter)";
		this.#sendButton.disabled =
			this.#unavailable || (action !== "stop" && (this.#pending !== undefined || this.#reading.count > 0)) || (action === "send" && !this.#hasContent());
		this.#followUpButton.classList.toggle("hidden", action !== "steer");
	}

	/** Shows `next` as chips, keeping the chips (and previews) of attachments that stay, and saves them with the draft. */
	#setAttachments(next: Attachment[]): void {
		this.#attachments = next;
		this.#deps.state.setAttachments(next);
		const kept = new Set(next.map(attachment => attachment.id));
		for (const [id, chip] of this.#chips) {
			if (kept.has(id)) continue;
			chip.remove();
			this.#chips.delete(id);
			const url = this.#previewUrls.get(id);
			if (url) URL.revokeObjectURL(url);
			this.#previewUrls.delete(id);
		}
		for (const attachment of next) {
			if (this.#chips.has(attachment.id)) continue;
			const chip = this.#renderChip(attachment);
			this.#chips.set(attachment.id, chip);
			this.#attachmentBar.append(chip);
		}
		this.#attachmentBar.classList.toggle("hidden", next.length === 0);
		this.#renderActions();
		this.#deps.onAttachmentsChange();
	}

	#renderChip(attachment: Attachment): HTMLElement {
		const remove = h(
			"button",
			{
				class: "plain chip-remove",
				title: `Remove ${attachment.label}`,
				attrs: { "aria-label": `Remove ${attachment.label}` },
				onClick: () => this.#setAttachments(this.#attachments.filter(other => other.id !== attachment.id)),
			},
			icon("x", 12),
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
			case "image": {
				let url = this.#previewUrls.get(attachment.id);
				if (!url) {
					const bytes = Uint8Array.from(atob(attachment.data), char => char.charCodeAt(0));
					url = URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
					this.#previewUrls.set(attachment.id, url);
				}
				return h(
					"span",
					{ class: "chip image", title: attachment.label },
					h("img", { attrs: { src: url, alt: "" } }),
					h("span", { class: "chip-label" }, attachment.label),
					remove,
				);
			}
		}
	}

	/** Attaches pasted images; pasted text goes into the input, or becomes an attachment when long. */
	#paste(event: ClipboardEvent): void {
		const images = imageFiles(event.clipboardData);
		if (images.length > 0) this.#addImageFiles(images);
		const text = event.clipboardData?.getData("text/plain") ?? "";
		if (text === "") {
			if (images.length > 0) event.preventDefault();
			return;
		}
		if (classifyPaste(text) === "inline") return;
		event.preventDefault();
		this.#setAttachments([...this.#attachments, { id: crypto.randomUUID(), kind: "text", text, label: `Pasted text ${++this.#pastedTextSequence}` }]);
	}

	#drop(event: DragEvent): void {
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length === 0) return;
		event.preventDefault();
		const images = imageFiles(event.dataTransfer);
		const others = files.filter(file => !images.includes(file));
		if (others.length > 0) {
			this.#deps.notice("warning", `Only images can be dropped here; use + to attach other files (not attached: ${others.map(file => file.name).join(", ")}).`);
		}
		if (images.length > 0) this.#addImageFiles(images);
	}

	/** Reads the images that fit the per-image, count and total limits into attachments; says which did not fit. */
	#addImageFiles(files: File[]): void {
		const attached = this.#attachments.flatMap(attachment => (attachment.kind === "image" ? [base64Bytes(attachment.data)] : []));
		const budget = { count: attached.length + this.#reading.count, bytes: attached.reduce((sum, bytes) => sum + bytes, 0) + this.#reading.bytes };
		const { accepted, rejected } = admitImages(budget, files);
		for (const message of rejected) this.#deps.notice("warning", message);
		for (const file of accepted) {
			this.#reading.count++;
			this.#reading.bytes += file.size;
			const reader = new FileReader();
			const finished = () => {
				this.#reading.count--;
				this.#reading.bytes -= file.size;
				this.#renderActions();
			};
			reader.onload = () => {
				finished();
				const url = String(reader.result);
				const data = url.slice(url.indexOf(",") + 1);
				const label = file.name && file.name !== "image.png" ? file.name : `Image ${++this.#imageSequence}`;
				const id = crypto.randomUUID();
				this.#previewUrls.set(id, URL.createObjectURL(file));
				this.#setAttachments([...this.#attachments, { id, kind: "image", data, mimeType: file.type, label }]);
			};
			reader.onerror = () => {
				finished();
				this.#deps.notice("error", `Reading ${file.name || "the pasted image"} failed${reader.error ? `: ${reader.error.message}` : ""}.`);
			};
			reader.readAsDataURL(file);
		}
		this.#renderActions();
	}
}
