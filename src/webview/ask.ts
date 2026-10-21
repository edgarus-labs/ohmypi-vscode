import type { AskQuestionView, InteractionResponse } from "../omp/api";

export type AskAnswers = Extract<InteractionResponse, { kind: "answers" }>["answers"];

export interface AskQuestionState {
	selected: string[];
	custom: string;
}

/**
 * Builds the `answers` payload per rpc.md: one entry per question in request order,
 * exact option labels without duplicates, single-select takes at most one option and
 * never both an option and `customInput`; empty free text is omitted.
 */
export function buildAskAnswers(questions: readonly AskQuestionView[], states: readonly AskQuestionState[]): AskAnswers {
	return questions.map((question, index) => {
		const state = states[index] ?? { selected: [], custom: "" };
		const chosen = new Set(state.selected);
		const selectedOptions = [...new Set(question.options.map(option => option.label))].filter(label => chosen.has(label));
		const customInput = state.custom.trim();
		if (!question.multi) {
			if (customInput) return { id: question.id, selectedOptions: [], customInput };
			const first = state.selected.find(label => selectedOptions.includes(label));
			return { id: question.id, selectedOptions: first === undefined ? [] : [first] };
		}
		return customInput ? { id: question.id, selectedOptions, customInput } : { id: question.id, selectedOptions };
	});
}
