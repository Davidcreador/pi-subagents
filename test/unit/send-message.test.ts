import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SendMessageParams } from "../../src/extension/schemas.ts";
import { sendMessageToChild } from "../../src/extension/send-message.ts";
import { activeChildControllers, foregroundSteerInboxDir } from "../../src/runs/foreground/active-child-controllers.ts";
import { consumeSteerRequests, consumeSteerRequestsFromDir } from "../../src/runs/background/control-channel.ts";
import { ChildThreadRegistry } from "../../src/runs/shared/child-thread-registry.ts";
import { writeControlHeartbeat } from "../../src/runs/shared/control-heartbeat.ts";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR, type SubagentState } from "../../src/shared/types.ts";
import { createTempDir, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

function state(): SubagentState {
	return { baseCwd: "", currentSessionId: "session-123", asyncJobs: new Map(), foregroundRuns: new Map(), foregroundControls: new Map(), lastForegroundControlId: null, cleanupTimers: new Map(), lastUiContext: null, poller: null, completionSeen: new Map(), watcher: null, watcherRestartTimer: null, resultFileCoalescer: { schedule: () => false, clear() {} } };
}

function setup(dir: string) {
	const registry = new ChildThreadRegistry({ filePath: path.join(dir, "registry.json") });
	const sessionFile = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionFile, "{}\n");
	return { registry, sessionFile, ctx: makeMinimalCtx(dir) as never, state: state(), trustedSessionRoots: () => [dir] };
}

describe("send_message", () => {
	it("has an exact two-field schema", () => {
		assert.deepEqual(Object.keys((SendMessageParams as { properties: object }).properties).sort(), ["message", "target"]);
		assert.equal((SendMessageParams as { additionalProperties?: boolean }).additionalProperties, false);
	});

	it("routes an alias to only its active foreground inbox", async () => {
		const dir = createTempDir("send-message-fg-");
		try {
			const deps = setup(dir);
			deps.registry.register({ originalTarget: "run:0", handle: "worker", parentSessionId: "session-123", runId: "run", index: 0, state: "running", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			const inbox = path.join(dir, "inbox-0");
			const otherInbox = path.join(dir, "inbox-1");
			const unregister = activeChildControllers.register("run:0", inbox);
			const unregisterOther = activeChildControllers.register("run:1", otherInbox);
			const response = await sendMessageToChild({ target: "worker", message: "focus" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("unexpected continuation"); } });
			assert.equal(response.isError, undefined);
			assert.equal(consumeSteerRequestsFromDir(inbox)[0]?.message, "focus");
			assert.equal(consumeSteerRequestsFromDir(otherInbox).length, 0);
			unregister(); unregisterOther();
		} finally { activeChildControllers.clear(); removeTempDir(dir); }
	});

	it("routes exact active async indexes in isolation", async () => {
		const dir = createTempDir("send-message-async-");
		try {
			const deps = setup(dir);
			const runId = `active-${randomUUID()}`;
			const target = `${runId}:1`;
			const asyncDir = path.join(dir, "async");
			const controlToken = randomUUID();
			fs.mkdirSync(asyncDir, { recursive: true });
			writeControlHeartbeat(asyncDir, controlToken);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId, sessionId: "session-123", mode: "parallel", state: "running", pid: process.pid, controlToken, startedAt: Date.now(), lastUpdate: Date.now(), cwd: dir, steps: [{ agent: "a", childTarget: `${runId}:0`, status: "running", sessionFile: deps.sessionFile }, { agent: "b", childTarget: target, status: "running", sessionFile: deps.sessionFile }] }));
			deps.registry.register({ originalTarget: target, parentSessionId: "session-123", runId, index: 1, state: "running", cwd: dir, agent: "b", sessionFile: deps.sessionFile, asyncDir });
			const response = await sendMessageToChild({ target, message: "only b" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("unexpected continuation"); } });
			assert.equal(response.isError, undefined);
			const requests = consumeSteerRequests(asyncDir);
			assert.equal(requests.length, 1);
			assert.equal(requests[0]?.targetIndex, 1);
		} finally { removeTempDir(dir); }
	});

	it("maps a reserved canonical target to its dense async runtime index", async () => {
		const dir = createTempDir("send-message-dynamic-index-");
		try {
			const deps = setup(dir);
			const runId = `dynamic-${randomUUID()}`;
			const canonicalTarget = `${runId}:5`;
			const asyncDir = path.join(dir, "async");
			const controlToken = randomUUID();
			fs.mkdirSync(asyncDir, { recursive: true });
			writeControlHeartbeat(asyncDir, controlToken);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				sessionId: "session-123",
				mode: "chain",
				state: "running",
				pid: process.pid,
				controlToken,
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				cwd: dir,
				steps: [
					{ agent: "producer", childTarget: `${runId}:0`, status: "complete" },
					{ agent: "reviewer", childTarget: `${runId}:1`, status: "complete" },
					{ agent: "consumer", childTarget: canonicalTarget, status: "running", sessionFile: deps.sessionFile },
				],
			}));
			deps.registry.register({ originalTarget: canonicalTarget, parentSessionId: "session-123", runId, index: 5, state: "running", cwd: dir, agent: "consumer", sessionFile: deps.sessionFile, asyncDir });
			const response = await sendMessageToChild({ target: canonicalTarget, message: "steer consumer" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("unexpected continuation"); } });
			assert.equal(response.isError, undefined);
			assert.equal(consumeSteerRequests(asyncDir)[0]?.targetIndex, 2);
		} finally { removeTempDir(dir); }
	});

	it("rejects stale active async records without recreating their directories", async () => {
		const dir = createTempDir("send-message-stale-async-");
		try {
			const deps = setup(dir);
			const missingAsyncDir = path.join(dir, "missing-async");
			deps.registry.register({ originalTarget: "stale:0", parentSessionId: "session-123", runId: "stale", index: 0, state: "running", cwd: dir, agent: "worker", sessionFile: deps.sessionFile, asyncDir: missingAsyncDir });
			const response = await sendMessageToChild({ target: "stale:0", message: "never delivered" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("unexpected continuation"); } });
			assert.equal(response.isError, true);
			assert.match(response.content[0]!.text, /stale async metadata/);
			assert.equal(fs.existsSync(missingAsyncDir), false);
		} finally { removeTempDir(dir); }
	});

	it("rejects stale live-PID async and foreground control leases", async () => {
		const dir = createTempDir("send-message-stale-lease-");
		const foregroundRunId = `stale-foreground-${randomUUID()}`;
		const foregroundTarget = `${foregroundRunId}:0`;
		const foregroundInbox = foregroundSteerInboxDir(foregroundRunId, 0);
		try {
			const deps = setup(dir);
			const asyncDir = path.join(dir, "async");
			const asyncToken = randomUUID();
			fs.mkdirSync(asyncDir, { recursive: true });
			writeControlHeartbeat(asyncDir, asyncToken, process.pid, Date.now() - 60_000);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "stale-live", sessionId: "session-123", mode: "single", state: "running", pid: process.pid, controlToken: asyncToken, startedAt: 1, cwd: dir, steps: [{ agent: "worker", childTarget: "stale-live:0", status: "running", sessionFile: deps.sessionFile }] }));
			deps.registry.register({ originalTarget: "stale-live:0", parentSessionId: "session-123", runId: "stale-live", index: 0, state: "running", cwd: dir, agent: "worker", sessionFile: deps.sessionFile, asyncDir });
			const asyncResponse = await sendMessageToChild({ target: "stale-live:0", message: "not queued" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("unexpected continuation"); } });
			assert.equal(asyncResponse.isError, true);
			assert.equal(consumeSteerRequests(asyncDir).length, 0);

			deps.registry.register({ originalTarget: foregroundTarget, parentSessionId: "session-123", runId: foregroundRunId, index: 0, state: "running", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			const unregister = activeChildControllers.register(foregroundTarget, foregroundInbox);
			activeChildControllers.clear();
			const marker = JSON.parse(fs.readFileSync(path.join(foregroundInbox, "active.json"), "utf-8")) as { token: string; pid: number };
			writeControlHeartbeat(foregroundInbox, marker.token, marker.pid, Date.now() - 60_000);
			const foregroundResponse = await sendMessageToChild({ target: foregroundTarget, message: "not queued" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("unexpected continuation"); } });
			assert.equal(foregroundResponse.isError, true);
			assert.equal(consumeSteerRequestsFromDir(foregroundInbox).length, 0);
			unregister();
		} finally {
			activeChildControllers.clear();
			fs.rmSync(path.dirname(foregroundInbox), { recursive: true, force: true });
			removeTempDir(dir);
		}
	});

	it("continues a settled exact thread and rejects missing sessions", async () => {
		const dir = createTempDir("send-message-settled-");
		try {
			const deps = setup(dir);
			deps.registry.register({ originalTarget: "done:0", handle: "done", parentSessionId: "session-123", runId: "done", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			let continued = "";
			const response = await sendMessageToChild({ target: "done:0", message: "next turn" }, deps.ctx, { ...deps, continueStoredChild: async ({ record, message, nextRunId }) => { continued = `${record.originalTarget}:${message}`; return { content: [{ type: "text", text: "continued" }], details: { mode: "single", results: [], asyncId: nextRunId, asyncDir: path.join(dir, nextRunId) } }; } });
			assert.equal(response.isError, undefined);
			assert.equal(continued, "done:0:next turn");
			deps.registry.register({ originalTarget: "missing:0", parentSessionId: "session-123", runId: "missing", index: 0, state: "failed", cwd: dir, agent: "worker", sessionFile: path.join(dir, "gone.jsonl") });
			const missing = await sendMessageToChild({ target: "missing:0", message: "retry" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("must not continue"); } });
			assert.equal(missing.isError, true);
			assert.match(missing.content[0]!.text, /does not exist/);
		} finally { removeTempDir(dir); }
	});

	it("routes an active foreground target after local controller state is cleared", async () => {
		const dir = createTempDir("send-message-reload-");
		const runId = `reload-${randomUUID().slice(0, 8)}`;
		const target = `${runId}:0`;
		const inbox = foregroundSteerInboxDir(runId, 0);
		let unregister: (() => void) | undefined;
		try {
			const deps = setup(dir);
			deps.registry.register({ originalTarget: target, parentSessionId: "session-123", runId, index: 0, state: "running", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			unregister = activeChildControllers.register(target, inbox, process.pid);
			activeChildControllers.clear();
			const response = await sendMessageToChild({ target, message: "from reloaded extension" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("unexpected continuation"); } });
			assert.equal(response.isError, undefined);
			assert.match(response.content[0]!.text, /queued/);
			assert.doesNotMatch(response.content[0]!.text, /acknowledged/);
			assert.equal(consumeSteerRequestsFromDir(inbox)[0]?.message, "from reloaded extension");
		} finally { unregister?.(); activeChildControllers.clear(); fs.rmSync(inbox, { recursive: true, force: true }); removeTempDir(dir); }
	});

	it("claims settled continuation once across concurrent callers and releases failed launches", async () => {
		const dir = createTempDir("send-message-claim-");
		try {
			const deps = setup(dir);
			deps.registry.register({ originalTarget: "claim:0", parentSessionId: "session-123", runId: "claim", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			let launches = 0;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			let firstNextRunId = "";
			const continueStoredChild = async ({ nextRunId }: { nextRunId: string }) => {
				launches++;
				firstNextRunId = nextRunId;
				await gate;
				return { content: [{ type: "text" as const, text: "continued" }], details: { mode: "single" as const, results: [], asyncId: nextRunId, asyncDir: path.join(dir, nextRunId) } };
			};
			const first = sendMessageToChild({ target: "claim:0", message: "one" }, deps.ctx, { ...deps, continueStoredChild });
			await new Promise((resolve) => setTimeout(resolve, 20));
			const second = await sendMessageToChild({ target: "claim:0", message: "two" }, deps.ctx, { ...deps, continueStoredChild });
			release();
			const firstResult = await first;
			assert.equal(launches, 1);
			assert.equal(firstResult.isError, undefined);
			assert.equal(second.isError, true);
			assert.match(second.content[0]!.text, /launch in progress/);
			assert.equal(deps.registry.resolve("claim:0", "session-123").latestRunId, firstNextRunId);

			deps.registry.register({ originalTarget: "retry:0", parentSessionId: "session-123", runId: "retry", index: 0, state: "failed", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			const failed = await sendMessageToChild({ target: "retry:0", message: "fail" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("launch failed"); } });
			assert.equal(failed.isError, true);
			const retried = await sendMessageToChild({ target: "retry:0", message: "retry" }, deps.ctx, { ...deps, continueStoredChild: async ({ nextRunId }) => ({ content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [], asyncId: nextRunId, asyncDir: path.join(dir, nextRunId) } }) });
			assert.equal(retried.isError, undefined);

			deps.registry.register({ originalTarget: "advance:0", parentSessionId: "session-123", runId: "advance", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			const completeContinuation = deps.registry.completeContinuation.bind(deps.registry);
			deps.registry.completeContinuation = (() => { throw new Error("registry unavailable"); }) as typeof deps.registry.completeContinuation;
			const launched = await sendMessageToChild({ target: "advance:0", message: "launch" }, deps.ctx, { ...deps, continueStoredChild: async ({ nextRunId }) => ({ content: [{ type: "text", text: "started" }], details: { mode: "single", results: [], asyncId: nextRunId, asyncDir: path.join(dir, nextRunId) } }) });
			assert.equal(launched.isError, true);
			assert.match(launched.content[0]!.text, /claim remains blocked/);
			deps.registry.completeContinuation = completeContinuation;
			const blocked = await sendMessageToChild({ target: "advance:0", message: "again" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("must stay blocked"); } });
			assert.equal(blocked.isError, true);
			assert.match(blocked.content[0]!.text, /launch in progress/);
		} finally { removeTempDir(dir); }
	});

	it("adopts a planned continuation after claimant death instead of launching a duplicate", async () => {
		const dir = createTempDir("send-message-planned-");
		const nextRunId = `planned-${randomUUID()}`;
		const asyncDir = path.join(ASYNC_DIR, nextRunId);
		try {
			const deps = setup(dir);
			deps.registry.register({ originalTarget: "crash:0", parentSessionId: "session-123", runId: "crash", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			assert.ok(deps.registry.claimContinuation("session-123", "crash:0", nextRunId));
			const controlToken = randomUUID();
			fs.mkdirSync(asyncDir, { recursive: true });
			writeControlHeartbeat(asyncDir, controlToken);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: nextRunId,
				sessionId: "session-123",
				mode: "single",
				state: "running",
				pid: process.pid,
				controlToken,
				startedAt: Date.now(),
				cwd: dir,
				steps: [{ agent: "worker", status: "running", cwd: dir, sessionFile: deps.sessionFile }],
			}));
			let launches = 0;
			const response = await sendMessageToChild({ target: "crash:0", message: "new guidance" }, deps.ctx, {
				...deps,
				continueStoredChild: async () => { launches++; throw new Error("must adopt planned run"); },
			});
			assert.equal(response.isError, undefined);
			assert.equal(launches, 0);
			assert.equal(consumeSteerRequests(asyncDir)[0]?.targetIndex, 0);
			const record = deps.registry.resolve("crash:0", "session-123");
			assert.equal(record.latestRunId, nextRunId);
			assert.equal(record.turn, 1);
			assert.equal(record.continuationClaim, undefined);
		} finally {
			fs.rmSync(asyncDir, { recursive: true, force: true });
			fs.rmSync(path.join(RESULTS_DIR, `${nextRunId}.json`), { force: true });
			removeTempDir(dir);
		}
	});

	it("adopts a nested planned continuation from its persisted locators", async () => {
		const dir = createTempDir("send-message-nested-planned-");
		const rootRunId = `root-${randomUUID()}`;
		const nextRunId = `nested-${randomUUID()}`;
		const nestedRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId);
		const asyncDir = path.join(nestedRoot, nextRunId);
		const resultRoot = path.join(RESULTS_DIR, "nested", rootRunId);
		const resultPath = path.join(resultRoot, `${nextRunId}.json`);
		try {
			const deps = setup(dir);
			deps.registry.register({ originalTarget: "nested-crash:0", parentSessionId: "session-123", runId: "nested-crash", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			assert.ok(deps.registry.claimContinuation("session-123", "nested-crash:0", nextRunId, { asyncDir, resultPath }));
			const controlToken = randomUUID();
			fs.mkdirSync(asyncDir, { recursive: true });
			writeControlHeartbeat(asyncDir, controlToken);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: nextRunId,
				sessionId: "session-123",
				mode: "single",
				state: "running",
				pid: process.pid,
				controlToken,
				startedAt: Date.now(),
				cwd: dir,
				steps: [{ agent: "worker", childTarget: `${nextRunId}:0`, status: "running", cwd: dir, sessionFile: deps.sessionFile }],
			}));
			let launches = 0;
			const response = await sendMessageToChild({ target: "nested-crash:0", message: "recover nested" }, deps.ctx, {
				...deps,
				continueStoredChild: async () => { launches++; throw new Error("must adopt nested run"); },
			});
			assert.equal(response.isError, undefined);
			assert.equal(launches, 0);
			assert.equal(consumeSteerRequests(asyncDir)[0]?.targetIndex, 0);
			assert.equal(deps.registry.resolve("nested-crash:0", "session-123").latestRunId, nextRunId);
		} finally {
			fs.rmSync(nestedRoot, { recursive: true, force: true });
			fs.rmSync(resultRoot, { recursive: true, force: true });
			removeTempDir(dir);
		}
	});

	it("continues from durable ownership after old async metadata is cleaned", async () => {
		const dir = createTempDir("send-message-cleaned-async-");
		try {
			const deps = setup(dir);
			const cleanedAsyncDir = path.join(dir, "cleaned-async");
			fs.mkdirSync(cleanedAsyncDir);
			deps.registry.register({ originalTarget: "cleaned:0", parentSessionId: "session-123", runId: "cleaned", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: deps.sessionFile, asyncDir: cleanedAsyncDir });
			fs.rmSync(cleanedAsyncDir, { recursive: true });
			let launches = 0;
			const response = await sendMessageToChild({ target: "cleaned:0", message: "continue" }, deps.ctx, {
				...deps,
				continueStoredChild: async ({ nextRunId }) => {
					launches++;
					return { content: [{ type: "text", text: "started" }], details: { mode: "single", results: [], asyncId: nextRunId, asyncDir: path.join(dir, nextRunId) } };
				},
			});
			assert.equal(response.isError, undefined);
			assert.equal(launches, 1);
		} finally { removeTempDir(dir); }
	});

	it("rejects a foreground registry record retargeted to another trusted session", async () => {
		const dir = createTempDir("send-message-owner-");
		try {
			const deps = setup(dir);
			const otherSession = path.join(dir, "other.jsonl");
			fs.writeFileSync(otherSession, "{}\n");
			deps.registry.register({ originalTarget: "owner-a:0", parentSessionId: "session-123", runId: "owner-a", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: deps.sessionFile });
			deps.registry.register({ originalTarget: "owner-b:0", parentSessionId: "session-123", runId: "owner-b", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: otherSession });
			const raw = JSON.parse(fs.readFileSync(deps.registry.filePath, "utf-8"));
			raw.sessions["session-123"].records["owner-a:0"].sessionFile = otherSession;
			fs.writeFileSync(deps.registry.filePath, JSON.stringify(raw));
			const response = await sendMessageToChild({ target: "owner-a:0", message: "continue" }, deps.ctx, {
				...deps,
				continueStoredChild: async () => { throw new Error("must not launch"); },
			});
			assert.equal(response.isError, true);
			assert.match(response.content[0]!.text, /durable ownership evidence/);
		} finally { removeTempDir(dir); }
	});

	it("restores a persisted custom session root after extension reload", async () => {
		const dir = createTempDir("send-message-custom-root-");
		const customRoot = createTempDir("send-message-custom-session-");
		try {
			const deps = setup(dir);
			const customSession = path.join(customRoot, "child.jsonl");
			fs.writeFileSync(customSession, "{}\n");
			deps.registry.register({ originalTarget: "custom-root:0", parentSessionId: "session-123", runId: "custom-root", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: customSession, trustedSessionRoot: customRoot });
			const response = await sendMessageToChild({ target: "custom-root:0", message: "continue after reload" }, deps.ctx, {
				...deps,
				trustedSessionRoots: () => [dir],
				continueStoredChild: async ({ nextRunId }) => ({ content: [{ type: "text", text: "continued" }], details: { mode: "single", results: [], asyncId: nextRunId, asyncDir: path.join(dir, nextRunId) } }),
			});
			assert.equal(response.isError, undefined);
		} finally {
			removeTempDir(customRoot);
			removeTempDir(dir);
		}
	});

	it("validates real session paths and allows production async session-file placement", async () => {
		const dir = createTempDir("send-message-trust-");
		const outside = createTempDir("send-message-outside-");
		try {
			const deps = setup(dir);
			const outsideFile = path.join(outside, "outside.jsonl");
			fs.writeFileSync(outsideFile, "{}\n");
			deps.registry.register({ originalTarget: "outside:0", parentSessionId: "session-123", runId: "outside", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: outsideFile });
			const rejected = await sendMessageToChild({ target: "outside:0", message: "no" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("must not launch"); } });
			assert.equal(rejected.isError, true);
			assert.match(rejected.content[0]!.text, /outside trusted session roots/);

			const link = path.join(dir, "linked");
			fs.symlinkSync(outside, link, "dir");
			deps.registry.register({ originalTarget: "symlink:0", parentSessionId: "session-123", runId: "symlink", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: path.join(link, "outside.jsonl") });
			const symlinkRejected = await sendMessageToChild({ target: "symlink:0", message: "no" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("must not launch"); } });
			assert.equal(symlinkRejected.isError, true);
			assert.match(symlinkRejected.content[0]!.text, /outside trusted session roots/);

			const asyncDir = path.join(dir, "owned-async");
			const statusSessionDir = path.join(dir, "session-root", "async-owned");
			const childSessionDir = path.join(dir, "session-root", "run-0");
			fs.mkdirSync(asyncDir);
			fs.mkdirSync(statusSessionDir, { recursive: true });
			fs.mkdirSync(childSessionDir, { recursive: true });
			const ownedFile = path.join(childSessionDir, "session.jsonl");
			fs.writeFileSync(ownedFile, "{}\n");
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: "owned", state: "complete", startedAt: 1, cwd: dir, sessionDir: statusSessionDir, steps: [{ agent: "worker", status: "complete", sessionFile: ownedFile }] }));
			deps.registry.register({ originalTarget: "owned:0", parentSessionId: "session-123", runId: "owned", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: ownedFile, asyncDir });
			const continued = await sendMessageToChild({ target: "owned:0", message: "continue" }, deps.ctx, { ...deps, continueStoredChild: async ({ nextRunId }) => ({ content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [], asyncId: nextRunId, asyncDir: path.join(dir, nextRunId) } }) });
			assert.equal(continued.isError, undefined);
		} finally { removeTempDir(dir); removeTempDir(outside); }
	});

	it("imports an exact legacy async target across parent sessions and preserves step cwd", async () => {
		const dir = createTempDir("send-message-legacy-");
		const runId = `legacy-${randomUUID().slice(0, 8)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		try {
			const deps = setup(dir);
			const childCwd = path.join(dir, "child-cwd");
			fs.mkdirSync(childCwd);
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId, sessionId: "historical-parent", mode: "single", state: "complete", startedAt: 1, endedAt: 2, cwd: dir, sessionDir: dir, steps: [{ agent: "worker", status: "complete", cwd: childCwd, sessionFile: deps.sessionFile }] }));
			let resumedCwd = "";
			const response = await sendMessageToChild({ target: `${runId}:0`, message: "continue" }, deps.ctx, { ...deps, continueStoredChild: async ({ record, nextRunId }) => { resumedCwd = record.cwd; return { content: [{ type: "text", text: "ok" }], details: { mode: "single", results: [], asyncId: nextRunId, asyncDir: path.join(dir, nextRunId) } }; } });
			assert.equal(response.isError, undefined);
			assert.equal(resumedCwd, childCwd);
			assert.equal(deps.registry.resolve(`${runId}:0`, "session-123").parentSessionId, "historical-parent");
		} finally { fs.rmSync(asyncDir, { recursive: true, force: true }); removeTempDir(dir); }
	});

	it("fails clearly when a stored child cwd has been cleaned", async () => {
		const dir = createTempDir("send-message-cwd-");
		try {
			const deps = setup(dir);
			const gone = path.join(dir, "gone-worktree");
			fs.mkdirSync(gone);
			deps.registry.register({ originalTarget: "gone:0", parentSessionId: "session-123", runId: "gone", index: 0, state: "complete", cwd: gone, agent: "worker", sessionFile: deps.sessionFile });
			fs.rmdirSync(gone);
			const response = await sendMessageToChild({ target: "gone:0", message: "continue" }, deps.ctx, { ...deps, continueStoredChild: async () => { throw new Error("must not launch"); } });
			assert.equal(response.isError, true);
			assert.match(response.content[0]!.text, /cwd no longer exists/);
		} finally { removeTempDir(dir); }
	});
});
