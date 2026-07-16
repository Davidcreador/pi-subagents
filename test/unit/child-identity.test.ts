import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childTarget, collectStaticChildIdentities, expandCountHandle, parseChildTarget, validateChildHandle, validateUniqueHandles } from "../../src/runs/shared/child-identity.ts";
import { materializeDynamicParallelStep } from "../../src/runs/shared/dynamic-fanout.ts";

describe("child thread identity", () => {
	it("builds and parses exact canonical targets", () => {
		assert.equal(childTarget("run-1", 3), "run-1:3");
		assert.deepEqual(parseChildTarget("run-1:3"), { runId: "run-1", flatIndex: 3 });
		assert.equal(parseChildTarget("run-1"), undefined);
		assert.equal(parseChildTarget("../run:0"), undefined);
	});

	it("validates safe handles and deterministic count expansion", () => {
		assert.equal(validateChildHandle("worker_1"), "worker_1");
		assert.throws(() => validateChildHandle("bad handle"), /start with a letter/);
		assert.throws(() => validateChildHandle("1worker"), /start with a letter/);
		assert.deepEqual([0, 1, 2].map((index) => expandCountHandle("review", 3, index)), ["review-1", "review-2", "review-3"]);
		assert.equal(expandCountHandle("review", 1, 0), "review");
	});

	it("rejects static and existing-session handle collisions", () => {
		assert.throws(() => validateUniqueHandles([
			{ handle: "worker", label: "first" },
			{ handle: "worker", label: "second" },
		]), /collides/);
		assert.throws(() => validateUniqueHandles([{ handle: "worker", label: "new" }], ["worker"]), /existing child thread/);
	});

	it("interpolates dynamic handle templates and rejects resolved collisions before launch", () => {
		const step = { expand: { from: { output: "items", path: "" }, item: "item", maxItems: 2 }, parallel: { agent: "fan", task: "{item.name}", handle: "worker-{item.id}" }, collect: { as: "done" } } as const;
		const materialized = materializeDynamicParallelStep(step, { items: { text: "", structured: [{ id: "a", name: "A" }, { id: "b", name: "B" }], agent: "source", stepIndex: 0 } }, 1);
		assert.deepEqual(materialized.parallel.map((task) => task.handle), ["worker-a", "worker-b"]);
		validateUniqueHandles(materialized.parallel.map((task, index) => ({ handle: task.handle, label: `item ${index}` })));
		assert.throws(() => validateUniqueHandles(materialized.parallel.map((task, index) => ({ handle: task.handle, label: `item ${index}` })), ["worker-b"]), /collides/);
	});

	it("assigns stable flat indexes around reserved dynamic fanout slots", () => {
		const identities = collectStaticChildIdentities({
			runId: "abc",
			chain: [
				{ agent: "one", task: "x", handle: "first" },
				{ expand: { from: { output: "items", path: "" }, maxItems: 3 }, parallel: { agent: "fan", task: "{item}" }, collect: { as: "done" } },
				{ parallel: [{ agent: "two", handle: "second" }, { agent: "three" }] },
			],
		});
		assert.deepEqual(identities.map((entry) => entry.childTarget), ["abc:0", "abc:4", "abc:5"]);
	});
});
