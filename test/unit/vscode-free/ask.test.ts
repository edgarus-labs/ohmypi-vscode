import * as assert from "node:assert/strict";
import type { AskQuestionView } from "../../../src/omp/api";
import { buildAskAnswers } from "../../../src/webview/ask";

const questions: AskQuestionView[] = [
	{ id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], recommended: 1 },
	{ id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Billing" }, { label: "Search" }], multi: true },
];

describe("buildAskAnswers", () => {
	it("matches the rpc.md example shape exactly", () => {
		const answers = buildAskAnswers(questions, [
			{ selected: [], custom: "  DuckDB " },
			{ selected: ["Search", "Auth"], custom: "" },
		]);
		assert.deepEqual(answers, [
			{ id: "db", selectedOptions: [], customInput: "DuckDB" },
			{ id: "features", selectedOptions: ["Auth", "Search"] },
		]);
	});

	it("single-select keeps at most one option and drops it when free text is given", () => {
		assert.deepEqual(buildAskAnswers([questions[0]], [{ selected: ["SQLite", "Postgres"], custom: "" }]), [{ id: "db", selectedOptions: ["SQLite"] }]);
		assert.deepEqual(buildAskAnswers([questions[0]], [{ selected: ["SQLite"], custom: "Mongo" }]), [{ id: "db", selectedOptions: [], customInput: "Mongo" }]);
	});

	it("multi-select dedupes, drops unknown labels, keeps option order, may be empty, allows free text", () => {
		assert.deepEqual(buildAskAnswers([questions[1]], [{ selected: ["Search", "Nope", "Auth", "Search"], custom: " extra " }]), [
			{ id: "features", selectedOptions: ["Auth", "Search"], customInput: "extra" },
		]);
		assert.deepEqual(buildAskAnswers([questions[1]], [{ selected: [], custom: "   " }]), [{ id: "features", selectedOptions: [] }]);
	});

	it("lists a label once when two options share it", () => {
		const twice: AskQuestionView = { id: "env", question: "Where?", options: [{ label: "prod" }, { label: "prod" }, { label: "dev" }], multi: true };
		assert.deepEqual(buildAskAnswers([twice], [{ selected: ["prod", "dev"], custom: "" }]), [{ id: "env", selectedOptions: ["prod", "dev"] }]);
	});

	it("emits one entry per question in request order even without state", () => {
		assert.deepEqual(buildAskAnswers(questions, []), [
			{ id: "db", selectedOptions: [] },
			{ id: "features", selectedOptions: [] },
		]);
	});
});
