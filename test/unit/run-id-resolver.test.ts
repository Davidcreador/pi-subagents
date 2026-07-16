import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { SubagentState } from "../../src/shared/types.ts";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";

const routeRoots: string[] = [];
const fixtureId = (id: string): string => `${id}-${process.pid}`;

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function stateWithForeground(id: string): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map([[id, { runId: id, mode: "single", startedAt: 1, updatedAt: 1 }]]),
		lastForegroundControlId: id,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function nested(rootRunId: string, id: string) {
	const route = createNestedRoute(rootRunId);
	routeRoots.push(path.dirname(route.eventSink));
	writeNestedChild(route, rootRunId, id, 0);
	return route;
}

function writeNestedChild(route: ReturnType<typeof createNestedRoute>, parentRunId: string, id: string, parentStepIndex?: number) {
	writeNestedEvent(route, {
		type: "subagent.nested.updated",
		ts: 100,
		parentRunId,
		...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
		child: { id, parentRunId, ...(parentStepIndex !== undefined ? { parentStepIndex } : {}), depth: 1, path: [{ runId: parentRunId, ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}) }], state: "running", agent: "worker" },
	});
}

function stateWithNestedRoute(route: ReturnType<typeof createNestedRoute>): SubagentState {
	const state = stateWithForeground(fixtureId("foreground-only"));
	state.foregroundControls.set(route.rootRunId, { runId: route.rootRunId, mode: "single", startedAt: 1, updatedAt: 1, nestedRoute: route });
	return state;
}

describe("subagent run id resolver", () => {
	it("prefers exact foreground, then exact async, then exact nested before prefix matches", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-resolver-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, fixtureId("shared-id")), { recursive: true });
			nested(fixtureId("root-shared"), fixtureId("shared-id"));
			nested(fixtureId("root-prefix"), fixtureId("shared-id-child"));

			assert.equal(resolveSubagentRunId(fixtureId("shared-id"), { state: stateWithForeground(fixtureId("shared-id")), asyncDirRoot: asyncRoot, resultsDir })?.kind, "foreground");
			assert.equal(resolveSubagentRunId(fixtureId("shared-id"), { asyncDirRoot: asyncRoot, resultsDir })?.kind, "async");
			fs.rmSync(path.join(asyncRoot, fixtureId("shared-id")), { recursive: true, force: true });
			const resolved = resolveSubagentRunId(fixtureId("shared-id"), { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(resolved?.kind, "nested");
			assert.equal(resolved?.id, fixtureId("shared-id"));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports one combined ambiguity for prefixes across namespaces", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			const prefix = fixtureId("fanout");
			const asyncId = `${prefix}-async`;
			const nestedId = `${prefix}-nested`;
			fs.mkdirSync(path.join(asyncRoot, asyncId), { recursive: true });
			nested(fixtureId("root-fanout"), nestedId);
			assert.throws(
				() => resolveSubagentRunId(prefix, { asyncDirRoot: asyncRoot, resultsDir }),
				new RegExp(`Ambiguous subagent run id prefix '${prefix}' matched: async:${asyncId}, nested:${nestedId}`),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("limits nested lookup to active state routes when state is provided", () => {
		const allowed = nested(fixtureId("root-allowed"), fixtureId("shared-nested"));
		nested(fixtureId("root-outside"), fixtureId("shared-nested"));

		assert.throws(
			() => resolveSubagentRunId(fixtureId("shared-nested")),
			/ambiguous across authorized registries|ambiguous across registries/i,
		);
		assert.equal(resolveSubagentRunId(fixtureId("shared-nested"), { state: stateWithForeground(fixtureId("foreground-only")) }), undefined);
		const resolved = resolveSubagentRunId(fixtureId("shared-nested"), { state: stateWithNestedRoute(allowed) });
		assert.equal(resolved?.kind, "nested");
		assert.equal(resolved?.kind === "nested" ? resolved.match.rootRunId : undefined, fixtureId("root-allowed"));
	});

	it("limits nested lookup to descendants of a scoped child address", () => {
		const route = createNestedRoute(fixtureId("root-scoped"));
		routeRoots.push(path.dirname(route.eventSink));
		writeNestedChild(route, fixtureId("root-scoped"), fixtureId("same-child-zero"), 0);
		writeNestedChild(route, fixtureId("root-scoped"), fixtureId("same-child-one"), 1);

		assert.throws(
			() => resolveSubagentRunId("same-child", { nested: { routes: [route] } }),
			/Ambiguous subagent run id prefix 'same-child'/,
		);
		const resolved = resolveSubagentRunId("same-child", { nested: { routes: [route], descendantOf: { parentRunId: fixtureId("root-scoped"), parentStepIndex: 0 } } });
		assert.equal(resolved?.kind, "nested");
		assert.equal(resolved?.id, fixtureId("same-child-zero"));
		assert.equal(resolved?.kind === "nested" ? resolved.match.run.parentStepIndex : undefined, 0);
	});

	it("reports async prefix ambiguity without parsing resolver error text", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-async-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, fixtureId("dupe-one")), { recursive: true });
			fs.mkdirSync(path.join(asyncRoot, fixtureId("dupe-two")), { recursive: true });

			assert.throws(
				() => resolveSubagentRunId("dupe", { asyncDirRoot: asyncRoot, resultsDir }),
				new RegExp(`Ambiguous subagent run id prefix 'dupe' matched: async:${fixtureId("dupe-one")}, async:${fixtureId("dupe-two")}`),
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects unsafe nested id tokens before lookup", () => {
		assert.throws(() => resolveSubagentRunId("../run"), /safe id token/);
		assert.throws(() => resolveSubagentRunId("a/b"), /safe id token/);
		assert.throws(() => resolveSubagentRunId(""), /safe id token/);
	});
});
