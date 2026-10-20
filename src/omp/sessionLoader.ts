import * as fs from "node:fs";
import type { AgentRegistry } from "./agents";
import type { HostToolDefinition, Logger, SessionBinding } from "./api";
import { OmpRequestError, type OmpRpcClient } from "./client";
import type { AgentMessage } from "./protocol";
import { journaledThinkingSelector, selectableLevels } from "./thinking";
import type { SessionStore } from "./transcript";

/** Timeout of commands that bind or read a whole session. */
export const SESSION_COMMAND_TIMEOUT_MS = 60_000;

/** Configures fresh OMP clients, binds their session and loads it into the store and agent registry. */
export class SessionLoader {
	readonly #store: SessionStore;
	readonly #agents: AgentRegistry;
	readonly #logger: Logger;
	readonly #historyPageLimit: number;
	readonly #hostTools: readonly HostToolDefinition[];

	/** `historyPageLimit`: messages per `get_messages_page` request; `hostTools`: registered with every client. */
	constructor(store: SessionStore, agents: AgentRegistry, logger: Logger, historyPageLimit: number, hostTools: readonly HostToolDefinition[] = []) {
		this.#store = store;
		this.#agents = agents;
		this.#logger = logger;
		this.#historyPageLimit = historyPageLimit;
		this.#hostTools = hostTools;
	}

	/** Subagent progress, the host tools, plus the optional features (ask dialog, delta updates) a fresh client asks for. */
	async configure(client: OmpRpcClient): Promise<void> {
		await client.request("set_subagent_subscription", { level: "progress" });
		if (this.#hostTools.length > 0) {
			try {
				await client.request("set_host_tools", {
					tools: this.#hostTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
				});
			} catch (error) {
				if (!(error instanceof OmpRequestError) || error.code === "closed") throw error;
				this.#logger.warn(`OMP did not accept the VS Code tools (${error.code ?? "no code"}): ${error.message}`);
			}
		}
		try {
			await client.request("set_ask_dialog", { enabled: true });
		} catch (error) {
			this.#logger.info("OMP ask dialog unavailable; using select prompts", error);
		}
		try {
			const filter = await client.request("set_event_filter", { events: null, messageUpdates: "delta" });
			if (filter?.messageUpdates !== "delta") this.#logger.debug("OMP does not project message updates; using full snapshots");
		} catch (error) {
			this.#logger.warn("OMP event filter could not be set", error);
		}
	}

	/** Binds the session OMP starts with; returns a warning for the user when it is not the one asked for. */
	async bind(client: OmpRpcClient, binding: SessionBinding): Promise<string | undefined> {
		const timeoutMs = SESSION_COMMAND_TIMEOUT_MS;
		const file = binding.resumeSessionFile;
		if (file) {
			let warning: string;
			if (fs.existsSync(file)) {
				const { cancelled } = await client.request("switch_session", { sessionPath: file }, { timeoutMs });
				if (!cancelled) return undefined;
				warning = `Resuming ${file} was cancelled by an OMP extension; continuing in the session OMP started with`;
			} else {
				warning = `Session file ${file} no longer exists; starting a new session`;
				await client.request("new_session", {}, { timeoutMs });
			}
			this.#logger.warn(warning);
			return warning;
		}
		if (binding.newSession) await client.request("new_session", {}, { timeoutMs });
		return undefined;
	}

	/** Snapshot state, thinking levels, history and subagents after (re)binding a session. */
	async load(client: OmpRpcClient): Promise<void> {
		this.#store.applyState(await client.request("get_state"));
		const { levels } = await client.request("get_available_thinking_levels");
		const { model, thinkingLevel } = this.#store.session;
		this.#store.update({
			availableThinkingLevels: selectableLevels(levels, model?.reasoning === true),
			thinkingSelector: await journaledThinkingSelector(client, thinkingLevel, this.#logger),
		});
		this.#store.reset(await this.#loadMessages(client));
		this.#agents.clearSubagents();
		const { subagents } = await client.request("get_subagents");
		this.#agents.applySnapshot(subagents);
	}

	/** Paged history on protocol v2; one `get_messages` request when paging is unavailable or the pages changed. */
	async #loadMessages(client: OmpRpcClient): Promise<AgentMessage[]> {
		const timeoutMs = SESSION_COMMAND_TIMEOUT_MS;
		if (client.protocolVersion === 2) {
			try {
				const messages: AgentMessage[] = [];
				let cursor: string | undefined;
				let total: number | undefined;
				do {
					const page = await client.request(
						"get_messages_page",
						{ limit: this.#historyPageLimit, ...(cursor ? { cursor } : {}) },
						{ timeoutMs },
					);
					if (total !== undefined && page.totalMessages !== total) {
						throw new OmpRequestError("Message pages changed while loading", "get_messages_page", "stale_cursor");
					}
					total = page.totalMessages;
					messages.push(...page.messages);
					cursor = page.nextCursor;
				} while (cursor);
				return messages;
			} catch (error) {
				if (!(error instanceof OmpRequestError) || error.code === "closed" || error.code === "timeout") throw error;
				this.#logger.debug("Paged history unavailable; loading it in one request", error);
			}
		}
		const { messages } = await client.request("get_messages", undefined, { timeoutMs });
		return messages;
	}
}
