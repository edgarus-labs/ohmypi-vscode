import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "../shared/guards";
import { splitUserMessage } from "../shared/prompt";
import type { Logger, SessionSummary } from "./api";

const HEAD_BYTES = 64 * 1024;
const FIRST_MESSAGE_CHARS = 200;
/** Session files read at the same time, so large session directories stay within file-descriptor limits. */
const READ_CONCURRENCY = 16;

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
	let bytesRead: number;
	let stat: Stats;
	try {
		stat = await handle.stat();
		if (!stat.isFile()) return undefined;
		const buffer = Buffer.alloc(Math.min(HEAD_BYTES, stat.size));
		({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
		head = buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}

	const complete = bytesRead === stat.size ? head : head.slice(0, head.lastIndexOf("\n") + 1);
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
			const content = userText(entry.message.content);
			// The text the user typed, without the editor context, pasted text and attachments the prompt carries.
			const text = content === undefined ? undefined : splitUserMessage(content).text;
			if (!text) continue;
			const chars = Array.from(text);
			summary.firstMessage = chars.length > FIRST_MESSAGE_CHARS ? `${chars.slice(0, FIRST_MESSAGE_CHARS).join("")}…` : text;
		}
	}
	return hasHeader ? summary : undefined;
}

/**
 * Summaries of the OMP session files (`*.jsonl`) in `dir`, newest first. Only
 * the first 64 KiB of each file is read; files without a session header are
 * skipped, and so are entries that cannot be read: a directory or a file that
 * vanished silently, any other failure with a warning. Only a directory that
 * cannot be listed fails the call.
 */
export async function listSessions(dir: string, logger: Logger, read = readSummary): Promise<SessionSummary[]> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const files = names.filter(name => name.endsWith(".jsonl")).map(name => path.join(dir, name));
	const summaries: SessionSummary[] = [];
	let next = 0;
	const worker = async () => {
		while (next < files.length) {
			const file = files[next++];
			try {
				const summary = await read(file);
				if (summary) summaries.push(summary);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "EISDIR") logger.warn(`Skipped unreadable session file ${file}`, error);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));
	return summaries.sort((a, b) => b.modified - a.modified);
}
