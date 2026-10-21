import type { SessionView } from "../omp/api";
import { todoSummary } from "./chrome";
import { collapsible, h, type OpenState } from "./dom";
import { type IconName, icon } from "./icons";

const TODO_ICON: Record<string, IconName> = {
	completed: "circleCheck",
	in_progress: "circleDot",
	pending: "circle",
	abandoned: "circleSlash",
	blocked: "warning",
};

/** A short hash of `text` (cyrb53); names a todo list's content in dismissal keys. */
function contentHash(text: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Session state above the composer: last error, queued messages and the todo list. A todo list the user
 * closed stays hidden until its content changes.
 */
export class SessionPanel {
	readonly statusLine = h("div", { class: "statusline" });
	readonly queue = h("div", { class: "queue" });
	readonly todos = h("div", { class: "todos" });
	readonly #openState: OpenState;
	readonly #onDismissTodos: (key: string) => void;
	/** Dismissal keys of the todo lists the user closed. */
	#dismissed = new Set<string>();
	#todoList: SessionView["todos"] = [];
	/** Serialized todos and their dismissal key, kept together so the hash runs only when the todos change. */
	#todosJson = "";
	#todosDismissKey = "";
	/** Serialized queue and shown todos last rendered; unchanged lists keep their nodes (scroll offset, focus). */
	#queueKey = "";
	#todosKey = "";

	/** `onDismissTodos` remembers that the user closed the todo list with the given key. */
	constructor(openState: OpenState, onDismissTodos: (key: string) => void) {
		this.#openState = openState;
		this.#onDismissTodos = onDismissTodos;
	}

	/** Keys of the todo lists closed earlier (persisted by the host). */
	setDismissedTodos(keys: readonly string[]): void {
		this.#dismissed = new Set(keys);
		this.#renderTodos(this.#todoList);
	}

	render(session: SessionView): void {
		this.statusLine.replaceChildren(...(session.lastError ? [icon("error", 14), h("span", { class: "statusline-text" }, session.lastError)] : []));
		this.statusLine.title = session.lastError ?? "";
		this.#renderQueue(session.queue);
		this.#renderTodos(session.todos);
	}

	#dismissTodos(): void {
		this.#dismissed.add(this.#todosDismissKey);
		this.#onDismissTodos(this.#todosDismissKey);
		this.#renderTodos(this.#todoList);
	}

	#renderQueue(queue: SessionView["queue"]): void {
		const key = JSON.stringify(queue);
		if (key === this.#queueKey) return;
		this.#queueKey = key;
		const chip = (kind: string, text: string) =>
			h("span", { class: "queue-chip", title: text }, h("span", { class: "queue-kind" }, kind), h("span", { class: "queue-text" }, text));
		this.queue.replaceChildren(...queue.steering.map(text => chip("steer", text)), ...queue.followUp.map(text => chip("follow-up", text)));
	}

	#renderTodos(todos: SessionView["todos"]): void {
		this.#todoList = todos;
		const json = JSON.stringify(todos);
		if (json !== this.#todosJson) {
			this.#todosJson = json;
			this.#todosDismissKey = `todos:${contentHash(json)}`;
		}
		const key = this.#dismissed.has(this.#todosDismissKey) ? "" : json;
		if (key === this.#todosKey) return;
		this.#todosKey = key;
		const summary = key && todoSummary(todos);
		if (!summary) {
			this.todos.replaceChildren();
			return;
		}
		this.todos.replaceChildren(
			collapsible(this.#openState, "todos", [h("span", { class: "todo-summary", title: summary }, summary)], () =>
				h(
					"div",
					{ class: "todo-list" },
					...todos.map(phase =>
						h(
							"div",
							{ class: "todo-phase" },
							h("div", { class: "todo-phase-name" }, phase.name),
							...phase.tasks.map(task =>
								h(
									"div",
									{ class: `todo status-${task.status}`, title: task.status.replace("_", " ") },
									icon(TODO_ICON[task.status] ?? "circle", 14),
									h("span", { class: "todo-text" }, task.content),
								),
							),
						),
					),
				),
			),
			h(
				"button",
				{
					class: "plain todos-dismiss",
					title: "Hide the todo list until it changes",
					attrs: { "aria-label": "Hide the todo list" },
					onClick: () => this.#dismissTodos(),
				},
				icon("x", 12),
			),
		);
	}
}
