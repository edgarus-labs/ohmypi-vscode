import * as assert from "node:assert/strict";
import { useDom } from "./webviewDom";

function failure(check: () => void): Error {
	try {
		check();
	} catch (error) {
		return error as Error;
	}
	throw new Error("expected the assertion to fail");
}

describe("DOM test environment", () => {
	useDom();

	it("keeps failing assertions on DOM nodes small", () => {
		const list = document.createElement("ul");
		for (let index = 0; index < 50; index++) list.append(Object.assign(document.createElement("li"), { className: `row-${index}` }));
		document.body.append(list);
		const first = list.firstElementChild;
		const last = list.lastElementChild;
		assert.ok(first?.parentNode === list && first.nextElementSibling === list.children[1], "nodes keep their links");
		assert.ok(list.ownerDocument === document && document.body.contains(last), "nodes keep their document");

		for (const message of [
			failure(() => assert.equal(first, last)).message,
			failure(() => assert.deepEqual(first, last)).message,
			failure(() => assert.deepEqual([list], [first])).message,
		]) {
			assert.ok(message.length < 4000, `assertion message has ${message.length} characters`);
		}
	});
});
