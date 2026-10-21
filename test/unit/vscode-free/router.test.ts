import * as assert from "node:assert/strict";
import { isRouterPaused, isRouterRouting, routerStatusText, statusDisplayText } from "../../../src/shared/router";

describe("tier router status", () => {
	it("says router auto while the tier router is routing, with the tier of a verdict", () => {
		assert.equal(routerStatusText("tier-router: on (main on)"), "router auto");
		assert.equal(routerStatusText("tier-router: on"), "router auto");
		assert.equal(routerStatusText("tier: standard (0.91/0.07/0.02)"), "router auto · standard");
		assert.equal(routerStatusText("tier: premium (0.01/0.09/0.90)"), "router auto · premium");
	});

	it("says off when the router only serves subagents", () => {
		assert.equal(routerStatusText("tier-router: on (main off)"), "router off · subagents only");
	});

	it("flags a manual model and an unreachable classifier", () => {
		assert.equal(routerStatusText("tier-router: paused (model set manually: anthropic/claude-opus-5-5)"), "router paused · manual model, /tier-auto resumes");
		assert.equal(routerStatusText("tier-router: service DOWN"), "router · classifier down");
	});

	it("keeps text it does not recognise", () => {
		assert.equal(routerStatusText("something else"), "something else");
		assert.equal(routerStatusText("tier-router: online"), "tier-router: online");
		assert.equal(routerStatusText("tier-router: pausedx"), "tier-router: pausedx");
		assert.equal(routerStatusText("tier: "), "tier: ");
	});

	it("offers resuming only for the paused status", () => {
		assert.equal(isRouterPaused("tier-router: paused (model set manually: anthropic/claude-opus-5-5)"), true);
		assert.equal(isRouterPaused("tier-router: paused"), true);
		assert.equal(isRouterPaused("tier-router: on (main on)"), false);
		assert.equal(isRouterPaused("tier: standard (0.91/0.07/0.02)"), false);
		assert.equal(isRouterPaused("tier-router: pausedx"), false);
	});

	it("routes only while on with main routing or after a tier verdict", () => {
		assert.equal(isRouterRouting("tier-router: on (main on)"), true);
		assert.equal(isRouterRouting("tier: standard (0.91/0.07/0.02)"), true);
		assert.equal(isRouterRouting("tier-router: on (main off)"), false);
		assert.equal(isRouterRouting("tier-router: paused (model set manually: x/y)"), false);
		assert.equal(isRouterRouting("tier-router: service DOWN"), false);
	});

	it("maps only the tier key for display", () => {
		assert.equal(statusDisplayText("tier", "tier-router: on (main on)"), "router auto");
		assert.equal(statusDisplayText("lsp", "tier-router: on (main on)"), "tier-router: on (main on)");
	});
});
