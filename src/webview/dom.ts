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

/** Collapsible section whose body is built only once it is first opened. */
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
	let built = false;
	const build = () => {
		if (built) return;
		built = true;
		details.append(body());
	};
	if (state.isOpen(key) ?? defaultOpen) {
		details.open = true;
		build();
	}
	details.addEventListener("toggle", () => {
		state.setOpen(key, details.open);
		if (details.open) build();
	});
	return details;
}
