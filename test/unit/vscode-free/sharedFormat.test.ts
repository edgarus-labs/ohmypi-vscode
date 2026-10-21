import * as assert from "node:assert/strict";
import type { TranscriptItem } from "../../../src/omp/api";
import { compactTokens, elapsedText, fenceFor, formatCost, formatDuration, relativeTime, turnSummaryText } from "../../../src/shared/format";

describe("shared formatters", () => {
	it("formats costs with more precision below a dollar", () => {
		assert.equal(formatCost(0.02149), "$0.0215");
		assert.equal(formatCost(3.456), "$3.46");
	});

	it("switches to cents for a cost that rounds to a dollar", () => {
		assert.equal(formatCost(0.99996), "$1.00");
		assert.equal(formatCost(0.99994), "$0.9999");
	});

	it("formats durations", () => {
		assert.equal(formatDuration(850), "850ms");
		assert.equal(formatDuration(12_300), "12.3s");
		assert.equal(formatDuration(125_000), "2m 5s");
	});

	it("rounds a duration before choosing its unit, uses hours past an hour and clamps negative ones", () => {
		assert.equal(formatDuration(999.6), "1.0s");
		assert.equal(formatDuration(59_940), "59.9s");
		assert.equal(formatDuration(59_960), "1m 0s");
		assert.equal(formatDuration(3_599_600), "1h 0m");
		assert.equal(formatDuration(4_503_000), "1h 15m");
		assert.equal(formatDuration(-5), "0ms");
	});

	it("formats elapsed time", () => {
		assert.equal(elapsedText(0), "0s");
		assert.equal(elapsedText(12_400), "12s");
		assert.equal(elapsedText(65_000), "1m 05s");
		assert.equal(elapsedText(3_725_000), "1h 02m");
		assert.equal(elapsedText(-5), "0s");
	});

	it("switches elapsed time units exactly at the minute and the hour", () => {
		assert.equal(elapsedText(59_999), "59s");
		assert.equal(elapsedText(60_000), "1m 00s");
		assert.equal(elapsedText(3_599_000), "59m 59s");
		assert.equal(elapsedText(3_600_000), "1h 00m");
	});

	it("formats token counts compactly", () => {
		assert.equal(compactTokens(950), "950");
		assert.equal(compactTokens(12_340), "12.3k");
		assert.equal(compactTokens(8_000), "8k");
		assert.equal(compactTokens(2_500_000), "2.5M");
	});

	it("chooses the token unit after rounding, so a count that rounds to a thousand thousands reads in millions", () => {
		assert.equal(compactTokens(999_949), "999.9k");
		assert.equal(compactTokens(999_950), "1M");
		assert.equal(compactTokens(999_999), "1M");
		assert.equal(compactTokens(1_000_000), "1M");
	});

	describe("turn summary", () => {
		const summary = (overrides: Partial<Extract<TranscriptItem, { kind: "turn_summary" }>>): Extract<TranscriptItem, { kind: "turn_summary" }> => ({
			kind: "turn_summary",
			id: "turn-1",
			status: "completed",
			durationMs: 72_000,
			usage: { input: 12_300, output: 2_100, cacheRead: 8_000, cacheWrite: 1_500, costUsd: 0.0123 },
			...overrides,
		});

		it("names the duration, tokens and cost of a finished turn", () => {
			assert.equal(turnSummaryText(summary({})), "Worked 1m 12s · 12.3k in · 2.1k out · 8k cached · 1.5k cache write · $0.0123");
		});

		it("says how a stopped or failed turn ended", () => {
			assert.equal(turnSummaryText(summary({ status: "aborted", durationMs: 12_000 })).split(" · ")[0], "Stopped after 12s");
			assert.equal(turnSummaryText(summary({ status: "error", durationMs: 3_000 })).split(" · ")[0], "Failed after 3s");
		});

		it("leaves out zero and unknown parts", () => {
			const usage = { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 };
			assert.equal(turnSummaryText(summary({ durationMs: undefined, usage })), "Worked · 40 in");
			assert.equal(turnSummaryText(summary({ status: "aborted", durationMs: undefined, usage: { ...usage, input: 0, costUsd: 0 } })), "Stopped");
		});
	});

	it("fences text with more backticks than it contains", () => {
		assert.equal(fenceFor("plain"), "```");
		assert.equal(fenceFor("a ```` b"), "`````");
	});

	it("fences text with any number of backtick runs", () => {
		assert.equal(fenceFor("`a".repeat(200_000)), "```");
		assert.equal(fenceFor(`${"`a".repeat(200_000)}\`\`\`\``), "`````");
	});

	it("formats compact relative times with unit boundaries", () => {
		const now = Date.UTC(2026, 9, 4);
		const s = 1000;
		const m = 60 * s;
		const hr = 60 * m;
		const d = 24 * hr;
		const ago = (ms: number) => relativeTime(now - ms, now);
		assert.equal(ago(0), "now");
		assert.equal(ago(-5 * m), "now", "future timestamps read as now");
		assert.equal(ago(59 * s), "now");
		assert.equal(ago(60 * s), "1m");
		assert.equal(ago(5 * m + 30 * s), "5m");
		assert.equal(ago(59 * m + 59 * s), "59m");
		assert.equal(ago(60 * m), "1h");
		assert.equal(ago(3 * hr), "3h");
		assert.equal(ago(23 * hr + 59 * m), "23h");
		assert.equal(ago(24 * hr), "1d");
		assert.equal(ago(2 * d + 5 * hr), "2d");
		assert.equal(ago(6 * d + 23 * hr), "6d");
		assert.equal(ago(7 * d), "1w");
		assert.equal(ago(29 * d), "4w");
		assert.equal(ago(30 * d), "1mo");
		assert.equal(ago(125 * d), "4mo");
		assert.equal(ago(364 * d), "11mo");
		assert.equal(ago(365 * d), "1y");
		assert.equal(ago(3 * 365 * d + 10 * d), "3y");
	});
});
