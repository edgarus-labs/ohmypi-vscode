import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSummary } from "./api";
import { isRecord } from "./protocol";

const HEAD_BYTES = 64 * 1024;
const FIRST_MESSAGE_CHARS = 200;

function userText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
	}
	return undefined;
}

async function readSummary(file: string): Promise<SessionSummary | undefined> {
	const handle = await fs.open(file, "r");
	let head: string;
	let stat: Stats;
	try {
		stat = await handle.stat();
		if (!stat.isFile()) return undefined;
		const buffer = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		head = buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}

	const complete = head.length === stat.size ? head : head.slice(0, head.lastIndexOf("\n") + 1);
	const summary: SessionSummary = { path: file, modified: stat.mtimeMs, size: stat.size };
	let hasHeader = false;
	for (const line of complete.split("\n")) {
		if (line.trim() === "") continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(entry)) continue;
		if (entry.type === "session" && !hasHeader) {
			hasHeader = true;
			if (typeof entry.id === "string") summary.id = entry.id;
			if (typeof entry.cwd === "string") summary.cwd = entry.cwd;
		} else if (entry.type === "title" && typeof entry.title === "string" && entry.title.trim() !== "") {
			summary.title = entry.title.trim();
		} else if (entry.type === "message" && summary.firstMessage === undefined && isRecord(entry.message)) {
			if (entry.message.role !== "user") continue;
			const text = userText(entry.message.content)?.trim();
			if (text) summary.firstMessage = text.length > FIRST_MESSAGE_CHARS ? `${text.slice(0, FIRST_MESSAGE_CHARS)}…` : text;
		}
	}
	return hasHeader ? summary : undefined;
}

/**
 * Summaries of the OMP session files (`*.jsonl`) in `dir`, newest first. Only
 * the first 64 KiB of each file is read; files without a session header are skipped.
 */
export async function listSessions(dir: string): Promise<SessionSummary[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const summaries = await Promise.all(
		names
			.filter(name => name.endsWith(".jsonl"))
			.map(name =>
				readSummary(path.join(dir, name)).catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT" || error.code === "EISDIR" || error.code === "EACCES") return undefined;
					throw error;
				}),
			),
	);
	return summaries
		.filter((summary): summary is SessionSummary => summary !== undefined)
		.sort((a, b) => b.modified - a.modified);
}
