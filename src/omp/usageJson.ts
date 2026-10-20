import { deferred } from "../shared/deferred";
import type { Logger } from "./api";
import type { TransportClose } from "./client";
import type { OmpProcessHandle } from "./lifecycle";
import type { OmpProcessOptions } from "./process";

/** How long `omp usage --json` may run before the report keeps the names `/usage` gives. */
const USAGE_JSON_TIMEOUT_MS = 30_000;

const DEFAULT_SHUTDOWN_GRACE_MS = 3000;
const FALLBACK = "limits keep the names /usage gives";

export interface UsageJsonLaunch {
	spawn: (options: OmpProcessOptions) => OmpProcessHandle;
	/** Launch settings of the main OMP process; only the mode differs. */
	process: Omit<OmpProcessOptions, "mode" | "args">;
	logger: Logger;
	shutdownGraceMs?: number;
}

/**
 * Runs `omp usage --json`, which names the quota bucket of each limit where `/usage` does not, and returns
 * its stdout. Undefined, with a warning logged, when it cannot run, fails or times out. The process is always
 * shut down.
 */
export async function fetchUsageJson(launch: UsageJsonLaunch): Promise<string | undefined> {
	const { logger } = launch;
	let proc: OmpProcessHandle | undefined;
	let timer: NodeJS.Timeout | undefined;
	try {
		proc = launch.spawn({ ...launch.process, mode: ["usage", "--json"], args: [] });
		const chunks: Uint8Array[] = [];
		const closed = deferred<TransportClose | undefined>();
		proc.onData(chunk => chunks.push(chunk));
		proc.onClose(close => closed.resolve(close));
		timer = setTimeout(() => closed.resolve(undefined), USAGE_JSON_TIMEOUT_MS);
		const exit = await closed.promise;
		if (!exit) {
			logger.warn(`omp usage --json did not finish within ${USAGE_JSON_TIMEOUT_MS / 1000} s; ${FALLBACK}`);
			return undefined;
		}
		if (exit.error || exit.code !== 0) {
			logger.warn(`omp usage --json failed (exit ${exit.code ?? "unknown"}): ${exit.error?.message ?? exit.stderr ?? ""}; ${FALLBACK}`);
			return undefined;
		}
		return Buffer.concat(chunks).toString("utf8");
	} catch (error) {
		logger.warn(`omp usage --json could not run; ${FALLBACK}`, error);
		return undefined;
	} finally {
		clearTimeout(timer);
		await proc?.shutdown(launch.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS).catch(error => logger.warn("Stopping omp usage --json failed", error));
	}
}
