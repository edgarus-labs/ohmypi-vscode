import * as path from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
	const mocha = new Mocha({ ui: "bdd", timeout: 30_000, color: false });
	mocha.addFile(path.join(__dirname, process.env.OMP_IT_SUITE ?? "extension.test.js"));
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	mocha.run(failures => (failures > 0 ? reject(new Error(`${failures} integration test(s) failed`)) : resolve()));
	return promise;
}
