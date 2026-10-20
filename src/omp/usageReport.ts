import type { ProviderUsage, UsageLimit } from "./api";

const ANSI = /\u001b\[[0-9;]*m/g;
const USED = /^\s+(?<account>.+?): [\d.]+(?:%| \S+) used \((?<left>[\d.]+)% left\)(?<inUse>.*in use by this session)?/;
const RESETS = /^\s+resets (?<when>.+)$/;

/** The share the text may differ from the JSON by: the text prints what is left to one decimal. */
const USED_TOLERANCE = 0.06;
/** Id words that name a meter's unit or window, not a bucket. */
const NOISE: Partial<Record<string, true>> = { wtu: true, weekly: true, daily: true, monthly: true, "5h": true, "7d": true };

/** Whether `text` is OMP's `/usage` report, even one that lists no providers. */
export function isUsageReport(text: string): boolean {
	return text.includes("Usage (");
}

/**
 * Reads the text OMP's `/usage` command prints into providers and their rate limits. A provider is an
 * unindented line; a limit is a `- name` line followed by `account: … used (N% left)` and optionally
 * `resets …`. Entries without a used share (such as saved resets) are left out.
 */
export function parseUsageReport(text: string): ProviderUsage[] {
	const providers: ProviderUsage[] = [];
	if (!isUsageReport(text)) return providers;
	let limits: UsageLimit[] | undefined;
	let limitName: string | undefined;
	let last: UsageLimit | undefined;
	for (const raw of text.replace(ANSI, "").split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line === "" || line.startsWith("```") || line.startsWith("Usage (")) continue;
		if (!/^\s/.test(line) && !line.startsWith("- ")) {
			limits = [];
			providers.push({ provider: line.trim(), limits });
			limitName = undefined;
			last = undefined;
			continue;
		}
		if (!limits) continue;
		if (line.startsWith("- ")) {
			limitName = line.slice(2).trim();
			last = undefined;
			continue;
		}
		const used = USED.exec(line)?.groups;
		if (used && limitName !== undefined) {
			last = {
				name: limitName,
				account: used.account.trim(),
				usedPercent: Math.round((100 - Number(used.left)) * 100) / 100,
				inUse: used.inUse !== undefined,
			};
			limits.push(last);
			continue;
		}
		const resets = RESETS.exec(line)?.groups;
		if (resets && last) last.resets = resets.when.trim();
	}
	return providers;
}

interface ReportedLimit {
	/** The name OMP's text gives the limit. */
	name: string;
	/** The name with the bucket's words after the label. */
	qualifiedName: string;
	usedPercent: number;
}

/**
 * Renames the limits whose quota bucket `json` (the output of `omp usage --json`) names. OMP's text labels
 * every Antigravity Gemini bucket "Gemini"; the JSON carries the bucket in each limit's id
 * (`…:gemini-argon-wtu-weekly`). Each text limit is paired with the first unused JSON limit of the same
 * provider, name and used share. Every other limit, and every limit when the JSON is unusable, keeps its name.
 */
export function qualifyUsageBuckets(providers: readonly ProviderUsage[], json: string): void {
	const reported = readReport(json);
	if (!reported) return;
	for (const provider of providers) {
		const candidates = reported.get(providerKey(provider.provider));
		if (!candidates) continue;
		const taken = new Set<ReportedLimit>();
		for (const limit of provider.limits) {
			const match = candidates.find(
				candidate => !taken.has(candidate) && candidate.name === limit.name && Math.abs(candidate.usedPercent - limit.usedPercent) <= USED_TOLERANCE,
			);
			if (!match) continue;
			taken.add(match);
			limit.name = match.qualifiedName;
		}
	}
}

/** "Google Antigravity" in the text and "google-antigravity" in the JSON name the same provider. */
function providerKey(provider: string): string {
	return provider.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readReport(json: string): Map<string, ReportedLimit[]> | undefined {
	let root: unknown;
	try {
		root = JSON.parse(json);
	} catch {
		return undefined;
	}
	const reports = record(root)?.reports;
	if (!Array.isArray(reports)) return undefined;
	const byProvider = new Map<string, ReportedLimit[]>();
	for (const report of reports) {
		const provider = str(record(report)?.provider);
		const limits = record(report)?.limits;
		if (provider === undefined || !Array.isArray(limits)) continue;
		const key = providerKey(provider);
		const list = byProvider.get(key) ?? [];
		byProvider.set(key, list);
		for (const limit of limits) {
			const reportedLimit = toReportedLimit(record(limit));
			if (reportedLimit) list.push(reportedLimit);
		}
	}
	return byProvider;
}

function toReportedLimit(limit: Record<string, unknown> | undefined): ReportedLimit | undefined {
	const label = str(limit?.label);
	const used = record(limit?.amount)?.usedFraction;
	if (label === undefined || typeof used !== "number") return undefined;
	const lowerLabel = label.toLowerCase();
	const scope = record(limit?.scope);
	const tierValue = str(scope?.tier);
	const tier = tierValue && !lowerLabel.includes(tierValue.toLowerCase()) ? ` (${tierValue})` : "";
	const windowLabel = str(record(limit?.window)?.label) ?? str(scope?.windowId);
	const suffix = windowLabel && windowLabel.toLowerCase() !== "quota window" && !lowerLabel.includes(windowLabel.toLowerCase()) ? ` — ${windowLabel}` : "";
	const bucket = bucketOf(str(limit?.id), label);
	return { name: label + tier + suffix, qualifiedName: label + (bucket ? ` ${bucket}` : "") + tier + suffix, usedPercent: used * 100 };
}

/**
 * The words of the last segment of `id` that follow a word of `label` and are not a window or unit:
 * `gemini-argon-wtu-weekly` under "Gemini" is "Argon". An id that does not start with a word of the label names no bucket.
 */
function bucketOf(id: string | undefined, label: string): string {
	if (!id) return "";
	const words = id
		.slice(id.lastIndexOf(":") + 1)
		.split("-")
		.filter(word => word !== "");
	const labelWords = new Set(
		label
			.split(/[ &()]/)
			.filter(word => word !== "")
			.map(word => word.toLowerCase()),
	);
	if (words.length === 0 || !labelWords.has(words[0].toLowerCase())) return "";
	return words
		.slice(1)
		.map(word => word.toLowerCase())
		.filter(word => !NOISE[word] && !labelWords.has(word))
		.map(word => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}
