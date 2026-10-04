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
	return view;
}
