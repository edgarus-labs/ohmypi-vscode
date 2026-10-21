#!/usr/bin/env node
// Scripted stand-in for `omp --mode rpc-ui` speaking the OMP RPC wire protocol.
// Prompt scenarios are chosen by keywords in the prompt text:
//   crash (exit 3 mid-turn), slow (streams until aborted), approve (confirm), input, editor,
//   ask (ask dialog, or select when ask dialogs are off), subagent, background (settles later),
//   present (notify/setStatus/open_url/set_editor_text requests, notice/compaction/retry events,
//   session_info_update, config_update, streamed tool output), `tool <absolute path>` (read + edit),
//   `racyedit <absolute path>` (edits before the start event; both paths run to the end of the line),
//   bigframe (an assistant message above the 1 MiB frame limit, sent as rpc_chunk frames once
//   protocol v2 is negotiated); anything else streams an echo. A scenario that throws ends the turn
//   with an error prompt_result.
// Slash commands: COMMANDS is sent in `available_commands_update` right after `ready` and answers
//   `get_available_commands` (builtins with aliases/hint/subcommands, one `skill:` command).
// Flags: --no-session (no session file).
// Env: FAKE_OMP_SESSION_DIR (session files), FAKE_OMP_LOG (every stdin line is appended),
//      FAKE_OMP_THINKING=auto (start with the auto effort selector),
//      FAKE_OMP_NO_ASK_DIALOG=1 (set_ask_dialog fails), FAKE_OMP_CANCEL_SWITCH=1 (switch_session is vetoed),
//      FAKE_OMP_EXIT_IF_EXISTS=<file> (exit 4 before `ready` while that file exists),
//      FAKE_OMP_IGNORE_EOF=1, FAKE_OMP_IGNORE_SIGTERM=1, FAKE_OMP_SPAWN_CHILD=1 (shutdown tests; the child
//      exits 5 s after fake-omp is gone, later than any test waits for the host to clean it up).
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const env = process.env;
const noSession = process.argv.includes("--no-session");
const sessionDir = env.FAKE_OMP_SESSION_DIR || path.join(os.tmpdir(), "fake-omp-sessions");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const MODELS = [
	{
		id: "fake-large",
		name: "Fake Large",
		api: "anthropic-messages",
		provider: "fake-anthropic",
		baseUrl: "https://fake.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
		thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
	},
	{
		id: "fake-small",
		name: "Fake Small",
		api: "openai-responses",
		provider: "fake-openai",
		baseUrl: "https://fake.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	},
];

const COMMANDS = [
	{ name: "help", description: "Show available commands", source: "builtin" },
	{ name: "model", aliases: ["models"], description: "Select a model", source: "builtin" },
	{
		name: "effort",
		description: "Set the reasoning effort",
		input: { hint: "[level]" },
		subcommands: ["off", "low", "medium", "high", "auto"].map(name => ({ name, description: `Use ${name} effort` })),
		source: "builtin",
	},
	{
		name: "mcp",
		description: "Manage MCP servers",
		input: { hint: "<subcommand>" },
		subcommands: [
			{ name: "list", description: "List servers", usage: "/mcp list" },
			{ name: "add", description: "Add a server", usage: "/mcp add <name>" },
		],
		source: "builtin",
	},
	{ name: "skill:codebase-review", description: "Full repository codebase review", source: "skill" },
];

const state = {
	protocolVersion: 1,
	model: MODELS[0],
	thinkingLevel: env.FAKE_OMP_THINKING === "auto" ? "high" : "medium",
	thinkingSelector: env.FAKE_OMP_THINKING === "auto" ? "auto" : undefined,
	entries: [],
	fast: false,
	subscription: "off",
	askDialog: false,
	messageUpdates: "full",
	sessionId: "",
	sessionFile: undefined,
	sessionName: undefined,
	messages: [],
	running: undefined,
	queue: [],
	subagents: new Map(),
	pendingUi: new Map(),
	hostTools: [],
	pendingHostTools: new Map(),
};
let counter = 0;
const nextId = prefix => `${prefix}-${++counter}`;

/** OMP's physical frame limit (advertised in `ready`) and the payload size it splits larger frames into. */
const MAX_FRAME_BYTES = 1024 * 1024;
const CHUNK_PAYLOAD_BYTES = 256 * 1024;

/** Writes one frame; under protocol v2 a frame above the frame limit goes out as `rpc_chunk` frames, as OMP does. */
function send(frame) {
	const json = JSON.stringify(frame);
	if (state.protocolVersion !== 2 || Buffer.byteLength(json) + 1 <= MAX_FRAME_BYTES) {
		process.stdout.write(`${json}\n`);
		return;
	}
	const bytes = Buffer.from(json);
	const count = Math.ceil(bytes.length / CHUNK_PAYLOAD_BYTES);
	const chunkId = randomUUID();
	for (let index = 0; index < count; index++) {
		const data = bytes.subarray(index * CHUNK_PAYLOAD_BYTES, (index + 1) * CHUNK_PAYLOAD_BYTES).toString("base64");
		process.stdout.write(`${JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data })}\n`);
	}
}

function respond(command, id, data) {
	send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

function fail(command, id, error, code) {
	send({ id, type: "response", command, success: false, error, ...(code ? { code } : {}) });
}

function usage(total) {
	return {
		input: 100,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 120,
		cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
	};
}

function assistantMessage(content, extra = {}) {
	return {
		role: "assistant",
		content,
		api: state.model.api,
		provider: state.model.provider,
		model: state.model.id,
		usage: usage(0.001),
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

function journal(entry) {
	const full = { id: randomUUID().slice(0, 8), parentId: state.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...entry };
	state.entries.push(full);
	if (state.sessionFile) fs.appendFileSync(state.sessionFile, `${JSON.stringify(full)}\n`);
}

function persist(message) {
	state.messages.push(message);
	journal({ type: "message", message });
}

/** Mirrors OMP: the effort selector is journaled, with `configured: "auto"` while auto is selected. */
function journalThinking() {
	journal({ type: "thinking_level_change", thinkingLevel: state.thinkingLevel, ...(state.thinkingSelector === "auto" ? { configured: "auto" } : {}) });
}

function newSession() {
	state.sessionId = randomUUID();
	state.messages = [];
	state.entries = [];
	state.sessionName = undefined;
	state.subagents.clear();
	if (noSession) {
		state.sessionFile = undefined;
	} else {
		fs.mkdirSync(sessionDir, { recursive: true });
		const timestamp = new Date().toISOString();
		state.sessionFile = path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${state.sessionId}.jsonl`);
		fs.writeFileSync(state.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: state.sessionId, cwd: process.cwd(), timestamp })}\n`);
	}
	journalThinking();
}

function loadSession(file) {
	const lines = fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
	const header = lines.find(entry => entry.type === "session");
	if (!header) throw new Error(`Not a session file: ${file}`);
	state.sessionId = header.id;
	state.sessionFile = file;
	state.entries = lines.filter(entry => entry.type !== "session");
	state.messages = state.entries.filter(entry => entry.type === "message").map(entry => entry.message);
	state.subagents.clear();
}

function getState() {
	return {
		sessionId: state.sessionId,
		...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
		...(state.sessionName ? { sessionName: state.sessionName } : {}),
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		isStreaming: state.running !== undefined,
		isCompacting: false,
		fastModeEnabled: state.fast,
		fastModeActive: state.fast,
		messageCount: state.messages.length,
		queuedMessageCount: state.queue.length,
		hasPendingAsyncWork: false,
		isSettled: state.running === undefined,
		queuedMessages: { steering: state.queue.map(q => q.message), followUp: [] },
		todoPhases: [{ name: "Todos", tasks: [{ content: "Fake task", status: "in_progress" }] }],
		contextUsage: { tokens: 1200, contextWindow: state.model.contextWindow, percent: 0.6 },
	};
}

function messageUpdate(messageId, partialContent, event) {
	const message = state.messageUpdates === "delta" ? { role: "assistant" } : assistantMessage(partialContent);
	send({ type: "message_update", messageId, message, assistantMessageEvent: event });
}

async function streamAssistant(text, run) {
	const messageId = nextId("msg");
	send({ type: "message_start", messageId, message: assistantMessage([]) });
	const words = text.split(/(?<= )/);
	let sent = "";
	for (const word of words) {
		if (run.aborted) break;
		sent += word;
		messageUpdate(messageId, [{ type: "text", text: sent }], { type: "text_delta", contentIndex: 0, delta: word });
		await sleep(5);
	}
	const message = assistantMessage([{ type: "text", text: sent }], run.aborted ? { stopReason: "aborted" } : {});
	send({ type: "message_end", messageId, message });
	persist(message);
	return message;
}

function waitForUi(request) {
	send({ type: "extension_ui_request", ...request });
	return new Promise(resolve => state.pendingUi.set(request.id, resolve));
}

/** `hosttool <name> <json arguments>` calls a host tool the client registered and replies with its answer. */
async function scenarioHostTool(text, run) {
	const match = /hosttool\s+(\S+)\s*(.*)$/s.exec(text);
	if (!match) return streamAssistant("No host tool given.", run);
	const [, toolName, rawArgs] = match;
	if (!state.hostTools.includes(toolName)) return streamAssistant(`Host tool not registered: ${toolName}`, run);
	const id = nextId("host");
	const answer = new Promise(resolve => state.pendingHostTools.set(id, resolve));
	send({ type: "host_tool_call", id, toolCallId: nextId("call"), toolName, arguments: rawArgs ? JSON.parse(rawArgs) : {} });
	const result = await answer;
	const output = result.result?.content?.map(part => part.text ?? "").join("") ?? "";
	await streamAssistant(`Host tool ${result.isError ? "error" : "ok"}: ${output}`, run);
}

/**
 * Sends an assistant message calling tool `name` (after an optional `intro` text block), then runs the tool
 * under the same tool call id, as OMP does. `executeFirst` changes the file before any of these frames,
 * as when a host receives events late.
 */
async function runTool(_run, name, args, execute, { executeFirst = false, intro } = {}) {
	const toolCallId = nextId("call");
	const early = executeFirst ? execute() : undefined;
	const call = assistantMessage([...(intro ? [{ type: "text", text: intro }] : []), { type: "toolCall", id: toolCallId, name, arguments: args }], {
		stopReason: "toolUse",
	});
	const messageId = nextId("msg");
	send({ type: "message_start", messageId, message: assistantMessage([]) });
	send({ type: "message_end", messageId, message: call });
	persist(call);
	send({ type: "tool_execution_start", toolCallId, toolName: name, args });
	send({
		type: "tool_execution_update",
		toolCallId,
		toolName: name,
		args,
		partialResult: { content: [{ type: "text", text: `${name} in progress` }] },
	});
	await sleep(5);
	const result = early ?? execute();
	send({ type: "tool_execution_end", toolCallId, toolName: name, result, isError: result.isError === true });
	persist({
		role: "toolResult",
		toolCallId,
		toolName: name,
		content: result.content,
		isError: result.isError === true,
		details: result.details,
		timestamp: Date.now(),
	});
}

/** The text after `keyword` up to the end of its line, so a path may contain spaces. */
function argumentAfter(keyword, text) {
	return new RegExp(`\\b${keyword}[ \\t]+([^\\r\\n]+)`).exec(text)?.[1].trim();
}

async function scenarioTool(text, run) {
	const target = argumentAfter("tool", text);
	if (!target) return streamAssistant("No tool path given.", run);
	await runTool(
		run,
		"read",
		{ path: target },
		() => {
			const content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
			return { content: [{ type: "text", text: content }] };
		},
		{ intro: "Editing the file." },
	);
	await runTool(run, "edit", { path: target }, () => {
		const oldText = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
		const newText = `${oldText}// edited by fake-omp\n`;
		fs.writeFileSync(target, newText);
		const diff = `+// edited by fake-omp`;
		return {
			content: [{ type: "text", text: `Edited ${target}` }],
			details: { path: target, oldText, newText, diff, perFileResults: [{ path: target, diff }] },
		};
	});
	return streamAssistant("Done editing.", run);
}

async function scenarioRacyEdit(text, run) {
	const target = argumentAfter("racyedit", text);
	if (!target) return streamAssistant("No edit path given.", run);
	await runTool(
		run,
		"edit",
		{ path: target },
		() => {
			const oldText = fs.readFileSync(target, "utf8");
			const newText = `${oldText}// racy edit\n`;
			fs.writeFileSync(target, newText);
			return { content: [{ type: "text", text: `Edited ${target}` }], details: { path: target, oldText, newText, diff: "+// racy edit" } };
		},
		{ executeFirst: true },
	);
	return streamAssistant("Edited before the host saw the start event.", run);
}

function scenarioBigFrame() {
	const message = assistantMessage([{ type: "text", text: "big ".repeat(400_000) }]);
	const messageId = nextId("msg");
	send({ type: "message_start", messageId, message: assistantMessage([]) });
	send({ type: "message_end", messageId, message });
	persist(message);
}

async function scenarioSubagent(run) {
	const ids = ["Alpha", "Beta"];
	const emit = frame => {
		if (state.subscription !== "off") send(frame);
	};
	for (const [index, id] of ids.entries()) {
		const sessionFile = path.join(sessionDir, `${state.sessionId}`, `${id}.jsonl`);
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		const messages = [{ role: "user", content: `Task for ${id}`, timestamp: Date.now() }, assistantMessage([{ type: "text", text: `${id} reporting` }])];
		fs.writeFileSync(sessionFile, messages.map(message => `${JSON.stringify({ type: "message", message })}\n`).join(""));
		const snapshot = { id, index, agent: "task", agentSource: "bundled", status: "running", lastUpdate: Date.now(), description: `Fake ${id}`, sessionFile };
		state.subagents.set(id, snapshot);
		emit({
			type: "subagent_lifecycle",
			payload: { id, agent: "task", agentSource: "bundled", status: "started", index, description: `Fake ${id}`, sessionFile },
		});
	}
	await sleep(20);
	for (const [index, id] of ids.entries()) {
		const progress = {
			index,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: `Task for ${id}`,
			currentTool: "grep",
			recentTools: [],
			recentOutput: [],
			toolCount: 2,
			requests: 1,
			tokens: 500,
			cost: 0.002,
			durationMs: 20,
			resolvedModel: `${state.model.provider}/${state.model.id}`,
		};
		emit({
			type: "subagent_progress",
			payload: { index, agent: "task", agentSource: "bundled", task: `Task for ${id}`, progress, sessionFile: state.subagents.get(id).sessionFile },
		});
	}
	await sleep(20);
	for (const [index, id] of ids.entries()) {
		const sessionFile = state.subagents.get(id).sessionFile;
		state.subagents.delete(id);
		emit({ type: "subagent_lifecycle", payload: { id, agent: "task", agentSource: "bundled", status: "completed", index, sessionFile } });
	}
	state.finishedSubagentFiles ??= new Map();
	for (const id of ids) state.finishedSubagentFiles.set(id, path.join(sessionDir, `${state.sessionId}`, `${id}.jsonl`));
	return streamAssistant("Both subagents completed.", run);
}

async function scenarioPresent(run) {
	send({ type: "extension_ui_request", id: nextId("ui"), method: "notify", message: "Heads up", notifyType: "warning" });
	send({ type: "extension_ui_request", id: nextId("ui"), method: "setStatus", statusKey: "fake", statusText: "busy" });
	send({ type: "extension_ui_request", id: nextId("ui"), method: "setStatus", statusKey: "fake" });
	send({
		type: "extension_ui_request",
		id: nextId("ui"),
		method: "open_url",
		url: "https://fake.invalid/login",
		launchUrl: "https://fake.invalid/launch",
		instructions: "Sign in",
	});
	send({ type: "extension_ui_request", id: nextId("ui"), method: "set_editor_text", text: "draft text" });
	send({ type: "notice", level: "info", message: "Fake notice", source: "fake" });
	send({ type: "auto_compaction_start", reason: "threshold", action: "compact" });
	send({ type: "auto_compaction_end", action: "compact", aborted: false, willRetry: false, errorMessage: "too small" });
	send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "overloaded" });
	send({ type: "auto_retry_end", success: false, attempt: 3, finalError: "still overloaded" });
	state.sessionName = "Presented";
	send({ type: "session_info_update", sessionId: state.sessionId, title: state.sessionName });
	send({ type: "config_update", thinkingLevel: state.thinkingLevel });
	const toolCallId = nextId("call");
	send({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "ls" } });
	send({
		type: "tool_execution_update",
		toolCallId,
		toolName: "bash",
		args: { command: "ls" },
		partialResult: { content: [{ type: "text", text: "streamed line" }] },
	});
	await sleep(5);
	send({ type: "tool_execution_end", toolCallId, toolName: "bash", result: { content: [{ type: "text", text: "a\nb" }] }, isError: false });
	return streamAssistant("Presented.", run);
}

async function scenarioSlow(run) {
	const messageId = nextId("msg");
	send({ type: "message_start", messageId, message: assistantMessage([]) });
	let sent = "";
	while (!run.aborted) {
		sent += "tick ";
		messageUpdate(messageId, [{ type: "text", text: sent }], { type: "text_delta", contentIndex: 0, delta: "tick " });
		await sleep(20);
	}
	const message = assistantMessage([{ type: "text", text: sent }], { stopReason: "aborted" });
	send({ type: "message_end", messageId, message });
	persist(message);
}

/** Runs prompt `id` in the background; a scenario that throws ends the turn with an error result instead of crashing. */
function startPrompt(id, text) {
	runPrompt(id, text).catch(error => {
		process.stderr.write(`fake-omp prompt ${id} failed: ${error?.stack ?? error}\n`);
		state.running = undefined;
		send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
		send({
			type: "prompt_result",
			id,
			agentInvoked: true,
			status: "error",
			sessionSettled: true,
			error: { message: String(error?.message ?? error), retryable: false },
		});
		send({ type: "session_settled" });
	});
}

async function runPrompt(id, text) {
	const run = { aborted: false };
	state.running = run;
	send({ type: "agent_start" });
	send({ type: "turn_start" });
	if (state.thinkingSelector === "auto") {
		state.thinkingLevel = "low";
		send({ type: "thinking_level_changed", thinkingLevel: "low", configured: "auto", resolved: "low" });
		journalThinking();
	}
	const userMessageId = nextId("user");
	const user = { role: "user", content: text, timestamp: Date.now() };
	send({ type: "message_start", messageId: userMessageId, message: user });
	send({ type: "message_end", messageId: userMessageId, message: user });
	persist(user);

	let settled = true;
	if (/\bcrash\b/.test(text)) {
		await streamAssistant("About to crash", run);
		process.exit(3);
	} else if (/\bslow\b/.test(text)) {
		await scenarioSlow(run);
	} else if (/\bapprove\b/.test(text)) {
		const answer = await waitForUi({
			id: nextId("ui"),
			method: "confirm",
			title: "Approve fake action?",
			message: "The fake agent wants to proceed.",
			timeout: 60000,
		});
		const decision = answer.cancelled ? "Cancelled" : answer.confirmed ? "Approved" : "Denied";
		await streamAssistant(`Decision: ${decision}`, run);
	} else if (/\binput\b/.test(text)) {
		const answer = await waitForUi({ id: nextId("ui"), method: "input", title: "Token", placeholder: "paste here", timeout: 60000 });
		await streamAssistant(`Received ${answer.value?.length ?? 0} characters`, run);
	} else if (/\beditor\b/.test(text)) {
		const answer = await waitForUi({ id: nextId("ui"), method: "editor", title: "Edit the plan", prefill: "step 1" });
		await streamAssistant(`Edited: ${answer.value ?? "cancelled"}`, run);
	} else if (/\bpresent\b/.test(text)) {
		await scenarioPresent(run);
	} else if (/\bask\b/.test(text)) {
		if (state.askDialog) {
			const answer = await waitForUi({
				id: nextId("ui"),
				method: "ask",
				questions: [
					{ id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite", description: "Embedded" }], recommended: 0 },
					{ id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Search" }], multi: true },
				],
				timeout: 60000,
			});
			await streamAssistant(`Answers: ${JSON.stringify(answer.answers ?? "cancelled")}`, run);
		} else {
			const answer = await waitForUi({
				id: nextId("ui"),
				method: "select",
				title: "Which database?",
				options: ["Postgres", "SQLite"],
				optionDetails: [{}, { description: "Embedded" }],
				timeout: 60000,
			});
			await streamAssistant(`Selected: ${answer.value ?? "cancelled"}`, run);
		}
	} else if (/\bsubagent\b/.test(text)) {
		await scenarioSubagent(run);
	} else if (/\bhosttool\b/.test(text)) {
		await scenarioHostTool(text, run);
	} else if (/\bbigframe\b/.test(text)) {
		scenarioBigFrame();
	} else if (/\bracyedit\b/.test(text)) {
		await scenarioRacyEdit(text, run);
	} else if (/\btool\b/.test(text)) {
		await scenarioTool(text, run);
	} else if (/\bbackground\b/.test(text)) {
		await streamAssistant("Started a background job.", run);
		settled = false;
	} else {
		await streamAssistant(`Echo: ${text}`, run);
	}

	const status = run.aborted ? "aborted" : "completed";
	send({ type: "turn_end", message: state.messages.at(-1), toolResults: [] });
	send({ type: "agent_end", messages: [], isTerminal: settled, yielded: true });
	state.running = undefined;
	const queued = state.queue.shift();
	if (queued) send({ type: "queue_update", steering: state.queue.map(q => q.message), followUp: [] });
	send({ type: "prompt_result", id, agentInvoked: true, status, sessionSettled: settled && !queued });
	if (queued) {
		startPrompt(queued.id, queued.message);
		return;
	}
	if (!settled) {
		await sleep(300);
		send({ type: "agent_start" });
		state.running = { aborted: false };
		await streamAssistant("Background job finished.", state.running);
		send({ type: "agent_end", messages: [], isTerminal: true, yielded: true });
		state.running = undefined;
	}
	send({ type: "session_settled" });
}

function handle(frame) {
	const { id, type } = frame;
	switch (type) {
		case "extension_ui_response": {
			const resolve = state.pendingUi.get(id);
			state.pendingUi.delete(id);
			resolve?.(frame);
			return;
		}
		case "host_tool_result": {
			const resolve = state.pendingHostTools.get(id);
			state.pendingHostTools.delete(id);
			resolve?.(frame);
			return;
		}
		case "set_host_tools":
			state.hostTools = (frame.tools ?? []).map(tool => tool.name);
			return respond(type, id, { tools: state.hostTools });
		case "negotiate_protocol":
			state.protocolVersion = frame.protocolVersion;
			return respond(type, id, { protocolVersion: frame.protocolVersion });
		case "get_state":
			return respond(type, id, getState());
		case "get_available_models":
			return respond(type, id, { models: MODELS });
		case "get_available_thinking_levels":
			return respond(type, id, { levels: ["off", ...(state.model.thinking?.efforts ?? [])] });
		case "get_available_commands":
			return respond(type, id, { commands: COMMANDS });
		case "set_model": {
			const model = MODELS.find(m => m.provider === frame.provider && m.id === frame.modelId);
			if (!model) return fail(type, id, `Model not found: ${frame.provider}/${frame.modelId}`);
			state.model = model;
			respond(type, id, model);
			return send({ type: "model_changed" });
		}
		case "set_thinking_level": {
			const wasAuto = state.thinkingSelector === "auto";
			if (frame.level === "auto") {
				state.thinkingSelector = "auto";
				respond(type, id);
				if (wasAuto) return;
				journalThinking();
				return send({ type: "thinking_level_changed", thinkingLevel: state.thinkingLevel, configured: "auto" });
			}
			state.thinkingSelector = undefined;
			state.thinkingLevel = frame.level;
			respond(type, id);
			journalThinking();
			return send({ type: "thinking_level_changed", thinkingLevel: frame.level });
		}
		case "get_entries":
			return respond(type, id, { entries: state.entries, leafId: state.entries.at(-1)?.id ?? null });
		case "set_fast_mode":
			state.fast = frame.enabled;
			return respond(type, id, { enabled: state.fast, active: state.fast });
		case "set_subagent_subscription":
			state.subscription = frame.level;
			return respond(type, id, { level: frame.level });
		case "set_ask_dialog":
			if (env.FAKE_OMP_NO_ASK_DIALOG === "1") return fail(type, id, "Ask dialogs are not supported", "unsupported");
			state.askDialog = frame.enabled;
			return respond(type, id, { enabled: frame.enabled });
		case "set_event_filter":
			state.messageUpdates = frame.messageUpdates ?? "full";
			return respond(type, id, { events: frame.events, messageUpdates: state.messageUpdates });
		case "new_session":
			newSession();
			return respond(type, id, { cancelled: false });
		case "switch_session":
			if (env.FAKE_OMP_CANCEL_SWITCH === "1") return respond(type, id, { cancelled: true });
			try {
				loadSession(frame.sessionPath);
			} catch (error) {
				return fail(type, id, error.message);
			}
			return respond(type, id, { cancelled: false });
		case "set_session_name":
			if (!frame.name) return fail(type, id, "Session name cannot be empty");
			state.sessionName = frame.name;
			return respond(type, id);
		case "get_messages":
			return respond(type, id, { messages: state.messages });
		case "get_messages_page": {
			const start = frame.cursor ? Number(frame.cursor) : 0;
			const limit = frame.limit ?? 100;
			const messages = state.messages.slice(start, start + limit);
			const next = start + messages.length;
			return respond(type, id, {
				messages,
				totalMessages: state.messages.length,
				...(next < state.messages.length ? { nextCursor: String(next) } : {}),
			});
		}
		case "get_subagents":
			return respond(type, id, { subagents: [...state.subagents.values()] });
		case "get_subagent_messages": {
			const file = state.subagents.get(frame.subagentId)?.sessionFile ?? state.finishedSubagentFiles?.get(frame.subagentId);
			if (!file) return fail(type, id, `Unknown subagent or session file unavailable: ${frame.subagentId}`);
			const messages = fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line).message);
			return respond(type, id, { sessionFile: file, fromByte: 0, nextByte: 0, reset: false, entries: [], messages });
		}
		case "cancel_subagent": {
			const cancelled = state.subagents.delete(frame.subagentId);
			return respond(type, id, { cancelled });
		}
		case "steer_subagent":
			if (!state.subagents.has(frame.subagentId)) return fail(type, id, `Subagent not running: ${frame.subagentId}`);
			return respond(type, id);
		case "abort":
			if (state.running) state.running.aborted = true;
			for (const [uiId, resolve] of state.pendingUi) {
				send({ type: "extension_ui_request", id: nextId("ui"), method: "cancel", targetId: uiId });
				resolve({ cancelled: true });
			}
			state.pendingUi.clear();
			return respond(type, id);
		case "prompt": {
			if (state.running) {
				if (!frame.streamingBehavior) return fail(type, id, "Agent is already processing. Specify streamingBehavior.");
				state.queue.push({ id, message: frame.message });
				respond(type, id);
				return send({ type: "queue_update", steering: state.queue.map(q => q.message), followUp: [] });
			}
			respond(type, id);
			startPrompt(id, frame.message);
			return;
		}
		default:
			return fail(type ?? "unknown", id, `Unknown command: ${type}`);
	}
}

if (env.FAKE_OMP_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => process.stderr.write("fake-omp ignoring SIGTERM\n"));
if (env.FAKE_OMP_SPAWN_CHILD === "1") {
	const watcher = `const parent = ${process.pid}; const watch = setInterval(() => { try { process.kill(parent, 0); } catch { clearInterval(watch); setTimeout(() => process.exit(), 5000); } }, 500);`;
	const child = spawn(process.execPath, ["-e", watcher], { stdio: "ignore" });
	process.stderr.write(`fake-omp child pid ${child.pid}\n`);
}

if (env.FAKE_OMP_EXIT_IF_EXISTS && fs.existsSync(env.FAKE_OMP_EXIT_IF_EXISTS)) {
	process.stderr.write("fake-omp refusing to start\n");
	process.exit(4);
}
newSession();
process.stderr.write(`fake-omp started pid ${process.pid} args ${JSON.stringify(process.argv.slice(2))}\n`);
send({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
send({ type: "extension_ui_request", id: nextId("ui"), method: "setWidget", widgetKey: "fake", widgetLines: ["fake widget"] });
send({ type: "available_commands_update", commands: COMMANDS });
send({ type: "fake_future_frame", note: "unknown frame types must be tolerated" });

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
	if (line.trim() === "") return;
	if (env.FAKE_OMP_LOG) fs.appendFileSync(env.FAKE_OMP_LOG, `${line}\n`);
	let frame;
	try {
		frame = JSON.parse(line);
	} catch (error) {
		return fail("parse", undefined, `Failed to parse command: ${error.message}`);
	}
	handle(frame);
});
lines.on("close", () => {
	if (env.FAKE_OMP_IGNORE_EOF === "1") {
		setInterval(() => {}, 1000);
		return;
	}
	process.exit(0);
});
