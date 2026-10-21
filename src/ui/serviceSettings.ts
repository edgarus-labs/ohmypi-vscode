import type * as vscode from "vscode";
import { resolveExecutable } from "../omp/executable";

/** The `omp.*` settings that configure the OMP process. */
export interface ServiceSettings {
	executable: string;
	extraArgs: string[];
	autoRestart: boolean;
}

/** Reads the process settings from the `omp` configuration section; throws when OMP cannot be started with them. */
export function readServiceSettings(config: vscode.WorkspaceConfiguration, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): ServiceSettings {
	const extraArgs = config.get<unknown>("extraArgs", []);
	if (!Array.isArray(extraArgs) || !extraArgs.every(arg => typeof arg === "string")) {
		throw new Error(`omp.extraArgs must be an array of strings, for example ["--profile", "work"]; got ${JSON.stringify(extraArgs)}`);
	}
	return {
		executable: resolveExecutable(config.get<string>("executablePath", ""), env, platform),
		extraArgs,
		autoRestart: config.get<boolean>("autoRestart", true),
	};
}
