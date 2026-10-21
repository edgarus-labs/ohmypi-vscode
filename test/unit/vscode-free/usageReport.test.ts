import * as assert from "node:assert/strict";
import { isUsageReport, parseUsageReport, qualifyUsageBuckets } from "../../../src/omp/usageReport";

const ESC = "\u001b";

/** The shape of OMP's `/usage` output, with made-up accounts. */
const OUTPUT = [
	"```",
	"Usage (0s ago)",
	"",
	"Anthropic",
	"  Models with usage data",
	"    anthropic/claude-opus-5-5",
	"    anthropic/claude-sonnet-5-5",
	"- Claude 5 Hour",
	"  user@example.com (Example Org): 4.00% used (96.0% left)  ← in use by this session",
	`  [${ESC}[38;2;107;114;128m█░░░░░░░░░░░░░░░░░░░░░░░${ESC}[39m] 4%`,
	"  resets in 4h",
	"- Claude 7 Day",
	"  user@example.com (Example Org): 32.00% used (68.0% left)  ← in use by this session\r",
	"  [████████░░░░░░░░░░░░░░░░] 32%",
	"  resets in 5d\r",
	"",
	"Cursor",
	"  Models with usage data",
	"    cursor/default",
	"- Other Models — Monthly",
	"  user@example.com: 20.00 usd used (0.0% left)",
	"  [████████████████████████] 100%",
	"  resets in 40h",
	"",
	"Openai Codex",
	"  Models with usage data",
	"    openai-codex/gpt-6-astra",
	"- user@example.com (team-id) · plan: team: 1 saved rate-limit reset — available — /usage reset to spend",
	"  soonest expires in 23d (2026-10-29)",
	"- 5 hours",
	"  user@example.com (team-id) · plan: team: 100.00% used (0.0% left)",
	"  [████████████████████████] 100%",
	"  resets in 2h",
	"```",
].join("\n");

const GEMINI = [
	"```",
	"Usage (0s ago)",
	"",
	"Google Antigravity",
	"- Gemini — Weekly",
	"  user@example.com: 9.64% used (90.4% left)",
	"  resets in 7d",
	"- Gemini — Weekly",
	"  user@example.com: 2.77% used (97.2% left)",
	"  resets in 6d",
	"- Gemini — 5 Hour",
	"  user@example.com: 0.00% used (100.0% left)",
	"  resets in 5h",
	"```",
].join("\n");

const GEMINI_JSON = JSON.stringify({
	reports: [
		{
			provider: "google-antigravity",
			limits: [
				{
					id: "google-antigravity:google:default:gemini-argon-wtu-weekly",
					label: "Gemini",
					scope: { windowId: "weekly" },
					window: { id: "weekly", label: "Weekly" },
					amount: { unit: "percent", usedFraction: 0.09636587 },
				},
				{
					id: "google-antigravity:google:default:gemini-weekly",
					label: "Gemini",
					scope: { windowId: "weekly" },
					window: { id: "weekly", label: "Weekly" },
					amount: { unit: "percent", usedFraction: 0.02770454 },
				},
				{
					id: "google-antigravity:google:default:gemini-5h",
					label: "Gemini",
					scope: { windowId: "5h" },
					window: { id: "5h", label: "5 Hour" },
					amount: { unit: "percent", usedFraction: 0 },
				},
			],
		},
	],
});

const names = (text: string, json: string) => {
	const providers = parseUsageReport(text);
	qualifyUsageBuckets(providers, json);
	return providers[0].limits.map(limit => limit.name);
};

describe("usage report", () => {
	it("reads each provider with its limits in order", () => {
		const report = parseUsageReport(OUTPUT);
		assert.deepEqual(
			report.map(provider => [provider.provider, provider.limits.map(limit => limit.name)]),
			[
				["Anthropic", ["Claude 5 Hour", "Claude 7 Day"]],
				["Cursor", ["Other Models — Monthly"]],
				["Openai Codex", ["5 hours"]],
			],
		);
	});

	it("gives a limit its account, used share, reset and whether this session uses it", () => {
		assert.deepEqual(parseUsageReport(OUTPUT)[0].limits[1], {
			name: "Claude 7 Day",
			account: "user@example.com (Example Org)",
			usedPercent: 32,
			inUse: true,
			resets: "in 5d",
		});
	});

	it("takes the used share of a limit counted in money from what is left", () => {
		const limit = parseUsageReport(OUTPUT)[1].limits[0];
		assert.equal(limit.usedPercent, 100);
		assert.equal(limit.inUse, false);
	});

	it("leaves out entries without a used share", () => {
		assert.deepEqual(
			parseUsageReport(OUTPUT)[2].limits.map(limit => limit.usedPercent),
			[100],
		);
	});

	it("recognises a report only by its Usage heading", () => {
		assert.equal(isUsageReport(OUTPUT), true);
		assert.equal(isUsageReport("```\nUsage (0s ago)\n```"), true);
		assert.equal(isUsageReport(""), false);
		assert.equal(isUsageReport("Unknown command: usage"), false);
		assert.deepEqual(parseUsageReport("Unknown command: usage"), []);
	});
});

describe("usage buckets", () => {
	it("names the bucket a limit belongs to when the JSON report ids one", () => {
		assert.deepEqual(names(GEMINI, GEMINI_JSON), ["Gemini Argon — Weekly", "Gemini — Weekly", "Gemini — 5 Hour"]);
	});

	it("pairs each limit by its used share when the reports list them in another order", () => {
		const swapped = GEMINI_JSON.replace("gemini-argon-wtu-weekly", "TMP").replace("gemini-weekly", "gemini-argon-wtu-weekly").replace("TMP", "gemini-weekly");
		assert.deepEqual(names(GEMINI, swapped).slice(0, 2), ["Gemini — Weekly", "Gemini Argon — Weekly"]);
	});

	it("keeps the text name when limits of the same name share a used share, as both buckets could be it", () => {
		const text = GEMINI.replace("9.64% used (90.4% left)", "2.77% used (97.2% left)");
		const json = GEMINI_JSON.replace("0.09636587", "0.02770454");
		assert.deepEqual(names(text, json), ["Gemini — Weekly", "Gemini — Weekly", "Gemini — 5 Hour"]);
	});

	it("renames limits whose equal used shares all name the same bucket", () => {
		const text = GEMINI.replace("9.64% used (90.4% left)", "2.77% used (97.2% left)");
		const json = GEMINI_JSON.replace("0.09636587", "0.02770454").replace("gemini-argon-wtu-weekly", "gemini-argon-weekly").replace("gemini-weekly", "gemini-argon-wtu-weekly");
		assert.deepEqual(names(text, json), ["Gemini Argon — Weekly", "Gemini Argon — Weekly", "Gemini — 5 Hour"]);
	});

	it("leaves a limit alone when no reported limit has its used share", () => {
		assert.deepEqual(names(GEMINI, GEMINI_JSON.replace("0.09636587", "0.5")).slice(0, 2), ["Gemini — Weekly", "Gemini — Weekly"]);
	});

	it("does not turn the ids of other providers into names, and keeps a tier already in the label", () => {
		const text = [
			"Usage (0s ago)",
			"Cursor",
			"- Other Models — Monthly",
			"  user@example.com: 0.00 usd used (100.0% left)",
			"Anthropic",
			"- Claude 7 Day (Fable)",
			"  user@example.com: 0.00% used (100.0% left)",
		].join("\n");
		const json = JSON.stringify({
			reports: [
				{ provider: "cursor", limits: [{ id: "cursor:usd:individual-api", label: "Other Models", scope: { windowId: "monthly" }, window: { label: "Monthly" }, amount: { usedFraction: 0 } }] },
				{ provider: "anthropic", limits: [{ id: "anthropic:7d:fable", label: "Claude 7 Day (Fable)", scope: { windowId: "7d", tier: "fable" }, window: { label: "7 Day" }, amount: { usedFraction: 0 } }] },
			],
		});
		const providers = parseUsageReport(text);
		qualifyUsageBuckets(providers, json);
		assert.deepEqual(
			providers.map(provider => provider.limits[0].name),
			["Other Models — Monthly", "Claude 7 Day (Fable)"],
		);
	});

	it("adds a tier the label lacks and skips the generic quota window", () => {
		const text = ["Usage (0s ago)", "Example", "- Pro (gold)", "  me: 50.00% used (50.0% left)"].join("\n");
		const json = JSON.stringify({
			reports: [{ provider: "example", limits: [{ id: "example:pro-extra", label: "Pro", scope: { tier: "gold" }, window: { label: "quota window" }, amount: { usedFraction: 0.5 } }] }],
		});
		assert.deepEqual(names(text, json), ["Pro Extra (gold)"]);
	});

	for (const json of ["", "not json", "{}", "[]", '{"reports":[{"provider":"google-antigravity"}]}']) {
		it(`leaves every name alone when the JSON report is not usable: ${JSON.stringify(json)}`, () => {
			assert.deepEqual(names(GEMINI, json), ["Gemini — Weekly", "Gemini — Weekly", "Gemini — 5 Hour"]);
		});
	}
});
