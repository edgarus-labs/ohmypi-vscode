import { errorMessage } from "../shared/errors";

export type Child = Node | string | null | undefined | false;

export interface Props {
	class?: string;
	title?: string;
	/** Set as attributes (e.g. `data-id`, `type`, `aria-pressed`). */
	attrs?: Record<string, string>;
	onClick?: (event: Event) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (props?.class) el.className = props.class;
	if (props?.title) el.title = props.title;
	if (props?.attrs) for (const [name, value] of Object.entries(props.attrs)) el.setAttribute(name, value);
	if (props?.onClick) {
		const onClick = props.onClick;
		el.addEventListener("click", event => {
			event.preventDefault();
			event.stopPropagation();
			onClick(event);
		});
	}
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child);
	}
	return el;
}

/** Remembers `<details>` open state across re-renders of the same item. */
export interface OpenState {
	isOpen(key: string): boolean | undefined;
	setOpen(key: string, open: boolean): void;
}

interface SectionBody {
	build: () => Node;
	built: boolean;
}

/** Body builders of collapsible sections; looked up when a section opens so a patch can swap them. */
const sectionBodies = new WeakMap<HTMLDetailsElement, SectionBody>();

function buildSection(details: HTMLDetailsElement): void {
	const body = sectionBodies.get(details);
	if (!body || body.built) return;
	body.built = true;
	let node: Node;
	try {
		node = body.build();
	} catch (error) {
		node = h("div", { class: "notice level-error" }, `Could not show this section: ${errorMessage(error)}`);
	}
	details.append(node);
}

/** Collapsible section whose body is built only once it is first opened; a body that fails to build shows why. */
export function collapsible(
	state: OpenState,
	key: string,
	summary: Child[],
	body: () => Node,
	defaultOpen = false,
	className = "",
): HTMLDetailsElement {
	const details = h("details", { class: className });
	details.append(h("summary", undefined, ...summary));
	sectionBodies.set(details, { build: body, built: false });
	if (state.isOpen(key) ?? defaultOpen) {
		details.open = true;
		buildSection(details);
	}
	details.addEventListener("toggle", () => {
		state.setOpen(key, details.open);
		if (details.open) buildSection(details);
	});
	return details;
}

const ELEMENT_NODE = 1;

function syncAttributes(target: Element, source: Element, keep?: string): void {
	for (const name of target.getAttributeNames()) if (name !== keep && !source.hasAttribute(name)) target.removeAttribute(name);
	for (const name of source.getAttributeNames()) {
		if (name === keep) continue;
		const value = source.getAttribute(name) ?? "";
		if (target.getAttribute(name) !== value) target.setAttribute(name, value);
	}
}

/** Makes listener-free `target` equal to `source`, reusing nodes of the same type so selections in unchanged text survive. */
function morph(target: Node, source: Node): void {
	if (target.nodeType !== ELEMENT_NODE) {
		if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
		return;
	}
	syncAttributes(target as Element, source as Element);
	const sourceChildren = [...source.childNodes];
	sourceChildren.forEach((child, index) => {
		const current = target.childNodes[index];
		if (!current) target.appendChild(child);
		else if (current.nodeName === child.nodeName) morph(current, child);
		else target.replaceChild(child, current);
	});
	while (target.childNodes.length > sourceChildren.length) target.lastChild?.remove();
}

/** Moves `source`'s summary and body into `target`, keeping `target`, its `<summary>` and its open state. */
function patchSection(target: HTMLDetailsElement, source: HTMLDetailsElement): void {
	syncAttributes(target, source, "open");
	const [targetSummary, ...targetBody] = [...target.children];
	const [sourceSummary, ...sourceBody] = [...source.children];
	targetSummary.replaceChildren(...sourceSummary.childNodes);
	for (const node of targetBody) node.remove();
	const body = sectionBodies.get(source);
	if (!body) throw new Error("patchSection needs two collapsible sections");
	sectionBodies.set(target, { build: body.build, built: body.built && target.open });
	if (!target.open) return;
	if (body.built) target.append(...sourceBody);
	else buildSection(target);
}

/**
 * Updates `target` (attributes and children) to match the freshly rendered `source` of the same item.
 * Children of both that carry the same `data-part` keep `target`'s node: collapsible sections are patched
 * (focus on their summary survives), any other part must be listener-free and is morphed. All other
 * children are taken from `source`.
 */
export function patchElement(target: HTMLElement, source: HTMLElement): void {
	syncAttributes(target, source);
	const parts = new Map<string, Element>();
	for (const child of target.children) {
		const part = child.getAttribute("data-part");
		if (part) parts.set(part, child);
	}
	const wanted: Node[] = [...source.childNodes].map(child => {
		const part = child.nodeType === ELEMENT_NODE ? (child as Element).getAttribute("data-part") : null;
		const kept = part ? parts.get(part) : undefined;
		if (!kept || kept.nodeName !== child.nodeName) return child;
		if (kept.nodeName === "DETAILS") patchSection(kept as HTMLDetailsElement, child as HTMLDetailsElement);
		else morph(kept, child);
		return kept;
	});
	wanted.forEach((node, index) => {
		const current = target.childNodes[index];
		if (current !== node) target.insertBefore(node, current ?? null);
	});
	while (target.childNodes.length > wanted.length) target.lastChild?.remove();
}
