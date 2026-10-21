import { setTimeout as sleep } from "node:timers/promises";
import { Node as LinkedNode, parseHTML } from "linkedom";
import type { HostMessage, WebviewMessage } from "../../../src/webview/protocol";
import type { SavedState, VsCodeApi } from "../../../src/webview/state";

const GLOBALS = ["window", "document", "ResizeObserver", "FileReader", "HTMLElement", "innerHeight", "setInterval", "clearInterval", "navigator"] as const;
const nodeSetInterval = globalThis.setInterval;
const nodeClearInterval = globalThis.clearInterval;
/** Intervals the webview started in the current test and has not cleared. */
const intervals = new Set<NodeJS.Timeout>();

/** How many intervals the webview keeps running. */
export function liveIntervals(): number {
	return intervals.size;
}

/** Reads a File as a data URL from its bytes (linkedom has no FileReader). */
class BufferFileReader {
	result: string | null = null;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;

	readAsDataURL(file: Blob): void {
		file.arrayBuffer().then(
			buffer => {
				this.result = `data:${file.type};base64,${Buffer.from(buffer).toString("base64")}`;
				this.onload?.();
			},
			() => this.onerror?.(),
		);
	}
}

/**
 * linkedom keeps each node's links to its document, parent and neighbours as enumerable own properties.
 * Node's assertions describe a failing value with `util.inspect` to depth 1000 (ignoring `inspect.custom`),
 * so one failing `assert.equal(nodeA, nodeB)` walks the whole linked document and needs gigabytes.
 * linkedom assigns these links with plain assignment, so prototype setters can store them as
 * non-enumerable own properties: nodes behave the same, and assertion messages stay a few hundred
 * characters. linkedom is only loaded by tests, so this is installed once for the test process.
 */
function hideNodeLinks(): void {
	const probe = parseHTML("<p></p>").document.createElement("p");
	const linkSymbols = Object.getOwnPropertySymbols(probe).filter(symbol => ["next", "prev", "end"].includes(symbol.description ?? ""));
	for (const key of ["ownerDocument", "parentNode", ...linkSymbols]) {
		Object.defineProperty(LinkedNode.prototype, key, {
			configurable: true,
			get: () => undefined,
			set(this: object, value: unknown) {
				Object.defineProperty(this, key, { value, writable: true, configurable: true, enumerable: false });
			},
		});
	}
}
hideNodeLinks();

/** Elements `focus()` was called on, in order. */
export const focused: Element[] = [];

/**
 * The element `focus()` last focused. As in browsers, `document.activeElement` is this element while it
 * stays in the document and `<body>` once it (or an ancestor) is removed, even if it is inserted again.
 */
let active: Element | null = null;

/** Elements `scrollIntoView()` was called on, in order. */
export const scrolledIntoView: Element[] = [];

/** Texts written to `navigator.clipboard`, in order. */
export const copied: string[] = [];

/** Collapsed caret of a textarea, valid while its value is still `value` (assigning a value moves the caret to the end). */
const carets = new WeakMap<Element, { value: string; position: number }>();

function caretOf(textarea: HTMLTextAreaElement): number {
	const caret = carets.get(textarea);
	return caret && caret.value === textarea.value ? caret.position : textarea.value.length;
}

function placeCaret(textarea: HTMLTextAreaElement, position: number): void {
	carets.set(textarea, { value: textarea.value, position });
}

/**
 * Gives each test in the enclosing `describe` a fresh linkedom document as the global
 * `window`/`document`, plus the browser APIs the webview uses that linkedom lacks.
 *
 * linkedom's `window` is a proxy that writes through to `globalThis`, so nothing may be
 * assigned to it directly: every global the tests need is installed here and restored after
 * each test, and intervals the webview starts are cleared so they cannot outlive the test.
 *
 * Compare node identity with `assert.ok(a === b)`: a structural comparison of two nodes does not
 * see their position in the document.
 */
export function useDom(): void {
	const saved = new Map<string, PropertyDescriptor | undefined>();
	const savedMembers: Array<{ prototype: object; name: string; descriptor: PropertyDescriptor | undefined }> = [];
	beforeEach(() => {
		const { window, document } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>');
		// linkedom has no focus: `focus()` moves `document.activeElement` to a connected, enabled element, and removing it drops focus.
		const removeElement = window.HTMLElement.prototype.remove;
		const elementMembers: Record<"focus" | "remove" | "scrollIntoView" | "open", PropertyDescriptor> = {
			focus: {
				value(this: HTMLElement) {
					focused.push(this);
					if (this.isConnected && !this.hasAttribute("disabled")) active = this;
				},
			},
			remove: {
				value(this: HTMLElement) {
					if (active && this.isConnected && this.contains(active)) active = null;
					removeElement.call(this);
				},
			},
			scrollIntoView: {
				value(this: Element) {
					scrolledIntoView.push(this);
				},
			},
			// linkedom has no HTMLDetailsElement: `open` reflects the attribute as in browsers.
			open: {
				get(this: Element) {
					return this.hasAttribute("open");
				},
				set(this: Element, open: boolean) {
					this.toggleAttribute("open", open);
				},
			},
		};
		// linkedom textareas have no selection: a collapsed caret is enough for the composer.
		const caretMember: PropertyDescriptor = {
			get(this: HTMLTextAreaElement) {
				return caretOf(this);
			},
			set(this: HTMLTextAreaElement, position: number) {
				placeCaret(this, position);
			},
		};
		const textareaMembers: Record<"selectionStart" | "selectionEnd" | "setSelectionRange", PropertyDescriptor> = {
			selectionStart: caretMember,
			selectionEnd: caretMember,
			setSelectionRange: {
				value(this: HTMLTextAreaElement, start: number) {
					placeCaret(this, start);
				},
			},
		};
		// linkedom's select has no `value` setter: as in browsers, it selects the first option with that value, or none.
		const selectMembers: Record<"value", PropertyDescriptor> = {
			value: {
				get(this: HTMLSelectElement) {
					return this.querySelector<HTMLOptionElement>("option[selected]")?.value ?? "";
				},
				set(this: HTMLSelectElement, value: string) {
					const match = [...this.options].find(option => option.value === value);
					for (const option of this.options) option.toggleAttribute("selected", option === match);
				},
			},
		};
		const install = (prototype: object, members: Record<string, PropertyDescriptor>) => {
			for (const [name, descriptor] of Object.entries(members)) {
				savedMembers.push({ prototype, name, descriptor: Object.getOwnPropertyDescriptor(prototype, name) });
				Object.defineProperty(prototype, name, { ...descriptor, configurable: true });
			}
		};
		install(window.HTMLElement.prototype, elementMembers);
		install(window.HTMLTextAreaElement.prototype, textareaMembers);
		install(window.HTMLSelectElement.prototype, selectMembers);
		focused.length = 0;
		active = null;
		scrolledIntoView.length = 0;
		copied.length = 0;
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => (active?.isConnected ? active : document.body) });
		const values: Record<(typeof GLOBALS)[number], unknown> = {
			window,
			document,
			ResizeObserver: class {
				observe(): void {}
				disconnect(): void {}
			},
			FileReader: BufferFileReader,
			HTMLElement: window.HTMLElement,
			innerHeight: 800,
			setInterval: (callback: () => void, ms: number) => {
				const handle = nodeSetInterval(callback, ms);
				intervals.add(handle);
				return handle;
			},
			clearInterval: (handle: NodeJS.Timeout | undefined) => {
				nodeClearInterval(handle);
				if (handle) intervals.delete(handle);
			},
			navigator: {
				clipboard: {
					writeText: async (text: string) => {
						copied.push(text);
					},
				},
			},
		};
		for (const name of GLOBALS) {
			saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
			Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
		}
	});
	afterEach(() => {
		for (const handle of intervals) nodeClearInterval(handle);
		intervals.clear();
		for (const name of GLOBALS) {
			const descriptor = saved.get(name);
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
		for (const { prototype, name, descriptor } of savedMembers.reverse()) {
			if (descriptor) Object.defineProperty(prototype, name, descriptor);
			else Reflect.deleteProperty(prototype, name);
		}
		savedMembers.length = 0;
	});
}

export interface FakeVsCodeApi extends VsCodeApi {
	posted: WebviewMessage[];
	state: SavedState | undefined;
	postedOf<T extends WebviewMessage["type"]>(type: T): Array<Extract<WebviewMessage, { type: T }>>;
}

export function fakeVsCodeApi(state?: SavedState): FakeVsCodeApi {
	const api: FakeVsCodeApi = {
		posted: [],
		state,
		postMessage: message => api.posted.push(message),
		getState: () => api.state,
		setState: next => {
			api.state = next;
		},
		postedOf: type => api.posted.filter((message): message is Extract<WebviewMessage, { type: typeof type }> => message.type === type),
	};
	return api;
}

/** An event of `type` carrying `extra` as own properties (e.g. `key`, `dataTransfer`). */
export function event(type: string, extra: Record<string, unknown> = {}): Event {
	const created = new window.Event(type, { bubbles: true, cancelable: true });
	for (const [name, value] of Object.entries(extra)) Object.defineProperty(created, name, { value });
	return created;
}

export function click(element: Element | null | undefined): void {
	if (!element) throw new Error("click target not found");
	element.dispatchEvent(event("click"));
}

/** Lets queued timers and promise callbacks run. */
export const settle = (ms = 5): Promise<void> => sleep(ms);

export type ResetMessage = Extract<HostMessage, { type: "reset" }>;
