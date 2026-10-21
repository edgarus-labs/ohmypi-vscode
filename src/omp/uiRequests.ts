import { errorMessage } from "../shared/errors";
import type { Event, InteractionRequest, InteractionResponse, Logger, PresentationRequest } from "./api";
import type { OmpRpcClient } from "./client";
import { Emitter } from "./emitter";
import type { ExtensionUiRequest, ExtensionUiResponse } from "./protocol";

/**
 * Translates OMP `extension_ui_request`s into host interactions and presentations,
 * and keeps the interactions that wait for the user's answer.
 */
export class UiRequestBroker {
	readonly #logger: Logger;
	readonly #warnUser: (text: string) => void;
	/** Kind of every interaction OMP still waits on, by request id. */
	readonly #pending = new Map<string, InteractionRequest["kind"]>();
	readonly #request: Emitter<InteractionRequest>;
	readonly #cancelled: Emitter<string>;
	readonly #presentation: Emitter<PresentationRequest>;
	/** Current status text by key, in the order OMP first set each key. */
	readonly #statuses = new Map<string, string>();
	readonly onRequest: Event<InteractionRequest>;
	readonly onCancelled: Event<string>;
	readonly onPresentation: Event<PresentationRequest>;

	/** `warnUser` shows a transcript warning; `onListenerError` receives listener failures. */
	constructor(logger: Logger, warnUser: (text: string) => void, onListenerError: (error: unknown) => void) {
		this.#logger = logger;
		this.#warnUser = warnUser;
		this.#request = new Emitter(onListenerError);
		this.#cancelled = new Emitter(onListenerError);
		this.#presentation = new Emitter(onListenerError);
		this.onRequest = this.#request.event;
		this.onCancelled = this.#cancelled.event;
		this.onPresentation = this.#presentation.event;
	}

	/** A request OMP sent through `client`; one that cannot be shown is cancelled so OMP stops waiting. */
	handle(client: OmpRpcClient, request: ExtensionUiRequest): void {
		try {
			this.#map(request);
		} catch (error) {
			const method = String(request.method);
			this.#logger.warn(`OMP ${method} request ${request.id} could not be shown; cancelling it`, error);
			this.#warnUser(`An OMP ${method} request could not be shown and was cancelled: ${errorMessage(error)}`);
			try {
				client.sendUiResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
			} catch (sendError) {
				this.#logger.error(`Failed to cancel OMP ${method} request ${request.id}`, sendError);
			}
		}
	}

	/**
	 * Answers a pending interaction through `client` (undefined while OMP is not running).
	 * Unknown or withdrawn ids are ignored; an answer that cannot be delivered throws and
	 * leaves the interaction pending. `input` answers never appear in RPC traces.
	 */
	respond(client: OmpRpcClient | undefined, id: string, response: InteractionResponse): void {
		const kind = this.#pending.get(id);
		if (!kind) {
			this.#logger.debug(`Response to an unknown or withdrawn OMP interaction ${id} ignored`);
			return;
		}
		if (!client) throw new Error("Cannot answer the OMP interaction: OMP is not running");
		let frame: ExtensionUiResponse;
		switch (response.kind) {
			case "value":
				frame = { type: "extension_ui_response", id, value: response.value };
				break;
			case "confirmed":
				frame = { type: "extension_ui_response", id, confirmed: response.confirmed };
				break;
			case "cancelled":
				frame = { type: "extension_ui_response", id, cancelled: true };
				break;
			case "answers":
				frame = { type: "extension_ui_response", id, answers: response.answers };
				break;
		}
		client.sendUiResponse(frame, kind === "input");
		this.#pending.delete(id);
	}

	/** Current status texts by key, in the order OMP first set each key. */
	get statuses(): ReadonlyMap<string, string> {
		return this.#statuses;
	}

	/** OMP went away: every pending interaction is withdrawn and every status cleared, each with its own event. */
	withdrawAll(): void {
		for (const id of this.#pending.keys()) this.#cancelled.fire(id);
		this.#pending.clear();
		const keys = [...this.#statuses.keys()];
		this.#statuses.clear();
		for (const key of keys) this.#presentation.fire({ kind: "status", key });
	}

	dispose(): void {
		this.#request.dispose();
		this.#cancelled.dispose();
		this.#presentation.dispose();
	}

	#map(request: ExtensionUiRequest): void {
		const method: string = request.method;
		const timeout = "timeout" in request && typeof request.timeout === "number" ? { timeoutMs: request.timeout } : {};
		switch (request.method) {
			case "confirm":
				this.#interact({ id: request.id, kind: "confirm", title: request.title, message: request.message, ...timeout });
				return;
			case "select":
				this.#interact({
					id: request.id,
					kind: "select",
					title: request.title,
					options: request.options.map((label, i) => {
						const description = request.optionDetails?.[i]?.description;
						return description ? { label, description } : { label };
					}),
					...timeout,
				});
				return;
			case "input":
				this.#interact({
					id: request.id,
					kind: "input",
					title: request.title,
					...(request.placeholder !== undefined ? { placeholder: request.placeholder } : {}),
					...timeout,
				});
				return;
			case "editor":
				this.#interact({
					id: request.id,
					kind: "editor",
					title: request.title,
					...(request.prefill !== undefined ? { prefill: request.prefill } : {}),
				});
				return;
			case "ask":
				this.#interact({ id: request.id, kind: "ask", questions: request.questions, ...timeout });
				return;
			case "cancel":
				if (this.#pending.delete(request.targetId)) this.#cancelled.fire(request.targetId);
				return;
			case "notify":
				this.#presentation.fire({ kind: "notify", message: request.message, level: request.notifyType ?? "info" });
				return;
			case "setStatus": {
				const key = request.statusKey;
				const text = request.statusText;
				if (text) this.#statuses.set(key, text);
				else this.#statuses.delete(key);
				this.#presentation.fire({ kind: "status", key, ...(text ? { text } : {}) });
				return;
			}
			case "open_url":
				this.#presentation.fire({
					kind: "openUrl",
					url: request.launchUrl ?? request.url,
					...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
				});
				return;
			case "set_editor_text":
				this.#presentation.fire({ kind: "editorText", text: request.text });
				return;
			case "setWidget":
			case "setTitle":
				this.#logger.debug(`OMP ${request.method} request ignored`);
				return;
			default:
				this.#logger.debug(`Unsupported OMP UI method ${method} ignored`);
		}
	}

	#interact(request: InteractionRequest): void {
		this.#pending.set(request.id, request.kind);
		this.#request.fire(request);
	}
}
