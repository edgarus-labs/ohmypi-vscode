import type { ModelView } from "./api";
import type { ModelInfo } from "./protocol";

/** Map OMP's wire model descriptor to the host view model. */
export function toModelView(model: ModelInfo): ModelView {
	const view: ModelView = {
		provider: model.provider,
		id: model.id,
		name: model.name || model.id,
		reasoning: model.reasoning === true,
		thinkingEfforts: [...(model.thinking?.efforts ?? [])],
		input: model.input?.length ? [...model.input] : ["text"],
	};
	if (model.api) view.api = model.api;
	if (typeof model.contextWindow === "number") view.contextWindow = model.contextWindow;
	if (typeof model.maxTokens === "number") view.maxTokens = model.maxTokens;
	const cost = model.cost;
	if (typeof cost?.input === "number" && typeof cost.output === "number") {
		view.cost = {
			input: cost.input,
			output: cost.output,
			cacheRead: typeof cost.cacheRead === "number" ? cost.cacheRead : 0,
			cacheWrite: typeof cost.cacheWrite === "number" ? cost.cacheWrite : 0,
		};
	}
	const identity: NonNullable<ModelView["identity"]> = {};
	for (const key of ["class", "family", "revision"] as const) {
		const value: unknown = model.identity?.[key];
		if (typeof value === "string" && value) identity[key] = value;
	}
	if (Object.keys(identity).length > 0) view.identity = identity;
	return view;
}
