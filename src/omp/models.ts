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
	if (model.cost) {
		const { input, output, cacheRead, cacheWrite } = model.cost;
		view.cost = { input, output, cacheRead, cacheWrite };
	}
	const identity: NonNullable<ModelView["identity"]> = {};
	for (const key of ["class", "family", "revision"] as const) {
		const value: unknown = model.identity?.[key];
		if (typeof value === "string" && value) identity[key] = value;
	}
	if (Object.keys(identity).length > 0) view.identity = identity;
	return view;
}
