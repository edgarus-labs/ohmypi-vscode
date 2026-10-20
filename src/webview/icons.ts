const SVG_NS = "http://www.w3.org/2000/svg";

type Shape = [tag: "path" | "circle" | "rect", attrs: Record<string, string>];

const path = (d: string): Shape => ["path", { d }];
const circle = (r: number, attrs: Record<string, string> = {}): Shape => ["circle", { cx: "12", cy: "12", r: String(r), ...attrs }];

/** 24×24 stroke icons drawn with `currentColor`. */
const ICONS = {
	plus: [path("M12 5v14"), path("M5 12h14")],
	chevronDown: [path("m6 9 6 6 6-6")],
	chevronRight: [path("m9 18 6-6-6-6")],
	arrowUp: [path("m5 12 7-7 7 7"), path("M12 19V5")],
	arrowDown: [path("M12 5v14"), path("m19 12-7 7-7-7")],
	stop: [["rect", { x: "6", y: "6", width: "12", height: "12", rx: "2", fill: "currentColor" }]],
	zap: [path("M13 2 3 14h9l-1 8 10-12h-9l1-8z")],
	fileCode: [path("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"), path("M14 2v6h6"), path("m10 13-2 2 2 2"), path("m14 17 2-2-2-2")],
	check: [path("M20 6 9 17l-5-5")],
	x: [path("M18 6 6 18"), path("m6 6 12 12")],
	spinner: [path("M21 12a9 9 0 1 1-6.22-8.56")],
	circle: [circle(9)],
	circleCheck: [circle(9), path("m9 12 2 2 4-4")],
	circleDot: [circle(9), circle(3, { fill: "currentColor" })],
	circleSlash: [circle(9), path("m9 15 6-6")],
	info: [circle(9), path("M12 16v-4"), path("M12 8h.01")],
	warning: [path("m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"), path("M12 9v4"), path("M12 17h.01")],
	error: [circle(9), path("m15 9-6 6"), path("m9 9 6 6")],
	logo: [path("M4 7.5c1-1.5 2.2-2 4-2h12"), path("M9 5.5c0 5-1 10-3.5 13"), path("M15.5 5.5c-.5 4.5-.3 9 .7 11.5.5 1.2 1.6 1.5 3.3.5")],
	copy: [["rect", { x: "8", y: "8", width: "13", height: "13", rx: "2" }], path("M4 16V5a1 1 0 0 1 1-1h11")],
	/** A speech bubble holding `/_`: the mark of a slash command. */
	slashCommand: [path("M10.5 17H17a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3v2.5z"), path("m7.5 13.5 3-5"), path("M12.5 13.5h4")],
	gauge: [path("m12 14 4-4"), path("M3.34 19a10 10 0 1 1 17.32 0")],
	refresh: [path("M3 12a9 9 0 0 1 15-6.7L21 8"), path("M21 3v5h-5"), path("M21 12a9 9 0 0 1-15 6.7L3 16"), path("M8 16H3v5")],
	clock: [circle(9), path("M12 7v5l3 2")],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

/** Decorative inline SVG (`aria-hidden`); label the surrounding control instead. */
export function icon(name: IconName, size = 16): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	for (const [attr, value] of Object.entries({
		width: String(size),
		height: String(size),
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		"stroke-width": "2",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
		focusable: "false",
		class: `icon icon-${name}`,
	})) {
		svg.setAttribute(attr, value);
	}
	for (const [tag, attrs] of ICONS[name] as Shape[]) {
		const shape = document.createElementNS(SVG_NS, tag);
		for (const [attr, value] of Object.entries(attrs)) shape.setAttribute(attr, value);
		svg.append(shape);
	}
	return svg;
}

/** Tiny ring meter; set the arc's `stroke-dasharray` to `"<percent> 100"` to fill it. */
export function ringMeter(size = 14): { svg: SVGSVGElement; arc: SVGCircleElement } {
	const svg = document.createElementNS(SVG_NS, "svg");
	for (const [attr, value] of Object.entries({ width: String(size), height: String(size), viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false", class: "ring" })) {
		svg.setAttribute(attr, value);
	}
	const circles = ["ring-track", "ring-fill"].map(className => {
		const circle = document.createElementNS(SVG_NS, "circle");
		for (const [attr, value] of Object.entries({ cx: "8", cy: "8", r: "6", fill: "none", "stroke-width": "2", pathLength: "100", class: className })) {
			circle.setAttribute(attr, value);
		}
		svg.append(circle);
		return circle;
	});
	circles[1].setAttribute("transform", "rotate(-90 8 8)");
	circles[1].setAttribute("stroke-dasharray", "0 100");
	return { svg, arc: circles[1] };
}
