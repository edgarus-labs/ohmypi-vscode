import type { OmpProcessHandle } from "../../src/omp/lifecycle";
import { MemoryTransport, READY_V2 } from "./helpers";

/** Returned by an override to send no response (the override replies itself, or never). */
export const NO_REPLY = Symbol("no reply");

type Override = (frame: Record<string, unknown>, omp: MemoryOmp) => unknown;

const DEFAULTS: Record<string, Override> = {
	negotiate_protocol: frame => ({ protocolVersion: frame.protocolVersion }),
	set_subagent_subscription: frame => ({ level: frame.level }),
	set_ask_dialog: frame => ({ enabled: frame.enabled }),
	set_event_filter: () => ({ events: null, messageUpdates: "delta" }),
	get_state: () => ({ sessionId: "memory-session", thinkingLevel: "off", isStreaming: false, isCompacting: false, messageCount: 0 }),
	get_available_thinking_levels: () => ({ levels: ["off"] }),
	get_entries: () => ({ entries: [], leafId: null }),
	get_messages_page: () => ({ messages: [], totalMessages: 0 }),
	get_messages: () => ({ messages: [] }),
	get_subagents: () => ({ subagents: [] }),
	get_available_commands: () => ({ commands: [] }),
	new_session: () => ({ cancelled: false }),
	switch_session: () => ({ cancelled: false }),
	abort: () => undefined,
};

let nextPid = 900_000;

/**
 * Scripted OMP process held in memory: it sends `ready` once the client listens and
 * answers every command with a minimal success unless an override handles it.
 */
export class MemoryOmp extends MemoryTransport implements OmpProcessHandle {
	readonly pid = ++nextPid;
	/** Makes `shutdown` reject, as when the process tree survives SIGKILL. */
	shutdownError: Error | undefined;

	constructor(overrides: Record<string, Override> = {}) {
		super((frame, transport) => {
			const type = String(frame.type);
			if (type === "extension_ui_response") return;
			const handler = overrides[type] ?? DEFAULTS[type];
			if (!handler) {
				transport.emit({ type: "response", id: frame.id, command: type, success: false, error: `Unknown command: ${type}` });
				return;
			}
			const data = handler(frame, this);
			if (data !== NO_REPLY) transport.reply(frame, data);
		});
		setImmediate(() => this.emit(READY_V2));
	}

	shutdown(): Promise<void> {
		if (this.shutdownError) return Promise.reject(this.shutdownError);
		if (!this.closed) this.close(0);
		return Promise.resolve();
	}
}
