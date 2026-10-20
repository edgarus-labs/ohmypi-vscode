import * as assert from "node:assert/strict";
import manifest from "../../package.json";
import type { AgentView, OmpServiceApi } from "../../src/omp/api";
import { type CommandDeps, registerCommands } from "../../src/ui/commands";
import { type MemoryLogger, memoryLogger, tick } from "./helpers";
import { stub } from "./stubs/vscode";

type CommandHandler = (...args: unknown[]) => Promise<void>;

describe("registerCommands", () => {
	let logger: MemoryLogger;
	let service: Partial<OmpServiceApi>;
	let shownLog: number;

	beforeEach(() => {
		stub.reset();
		logger = memoryLogger();
		service = {};
		shownLog = 0;
		const deps = {
			ensureService: async () => service as OmpServiceApi,
			needsStart: () => false,
			currentService: () => service as OmpServiceApi,
			restart: async () => {},
			chat: {},
			viewIds: { chat: "omp.chat", agents: "omp.agents", changes: "omp.changes" },
			agents: { current: [], find: () => undefined },
			changes: {},
			docs: {},
			output: { show: () => shownLog++ },
			logger,
		} as unknown as CommandDeps;
		registerCommands(deps);
	});

	function registered(): Map<string, CommandHandler> {
		return new Map(stub.callsTo("commands.registerCommand").map(([id, handler]) => [id as string, handler as CommandHandler]));
	}

	it("registers exactly the commands the manifest contributes", () => {
		const contributed = manifest.contributes.commands.map(command => command.command).sort();
		assert.deepEqual([...registered().keys()].sort(), contributed);
		assert.ok(!contributed.includes("omp.switchSession"));
	});

	it("hides only contributed commands from the command palette", () => {
		const contributed = new Set(manifest.contributes.commands.map(command => command.command));
		for (const entry of manifest.contributes.menus.commandPalette) assert.ok(contributed.has(entry.command), entry.command);
	});

	it("reports a failed steer of the main agent", async () => {
		const agent: AgentView = { id: "main", name: "main", status: "running" };
		service.steerAgent = async () => {
			throw new Error("OMP is not running (restarting)");
		};
		stub.on("window.showInputBox", () => "focus on tests");
		stub.on("window.showErrorMessage", () => "Show Log");
		await registered().get("omp.agent.steer")!(agent);
		await tick();
		assert.deepEqual(stub.callsTo("window.showErrorMessage"), [["OMP: OMP is not running (restarting)", "Show Log"]]);
		assert.equal(shownLog, 1);
		assert.match(logger.text("error"), /Command omp\.agent\.steer failed/);
	});
});
