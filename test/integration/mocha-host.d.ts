/**
 * `mocha-host` is Mocha 11 installed under an alias: the suites run inside the VS Code
 * extension host, whose Node (20.18 in VS Code 1.95) cannot load Mocha 12's ES modules.
 * Its API matches `@types/mocha`.
 */
declare module "mocha-host" {
	import Mocha from "mocha";
	export default Mocha;
}
