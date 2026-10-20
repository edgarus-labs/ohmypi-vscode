import * as path from "node:path";
import Mocha from "mocha-host";
import { deferred } from "../../src/shared/deferred";

export function run(): Promise<void> {
	const mocha = new Mocha({ ui: "bdd", timeout: 30_000, color: false });
	mocha.addFile(path.join(__dirname, process.env.OMP_IT_SUITE ?? "extension.test.js"));
	const finished = deferred<void>();
	mocha.run(failures => (failures > 0 ? finished.reject(new Error(`${failures} integration test(s) failed`)) : finished.resolve()));
	return finished.promise;
}
