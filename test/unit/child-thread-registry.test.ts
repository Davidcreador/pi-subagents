import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { ChildThreadRegistry } from "../../src/runs/shared/child-thread-registry.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

function runRegistryChild(script: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`registry child exited ${code}: ${stderr}`)));
	});
}

const registryModuleUrl = pathToFileURL(path.resolve("src/runs/shared/child-thread-registry.ts")).href;

describe("child thread registry", () => {
	it("persists metadata across instances and scopes aliases to the current parent session", () => {
		const dir = createTempDir("child-registry-");
		try {
			const filePath = path.join(dir, "deep", "v1", "registry.json");
			const first = new ChildThreadRegistry({ filePath, now: () => 10 });
			first.register({ originalTarget: "run-a:0", handle: "worker", parentSessionId: "parent-a", runId: "run-a", index: 0, state: "complete", cwd: dir, agent: "worker", sessionFile: path.join(dir, "session.jsonl") });
			const restored = new ChildThreadRegistry({ filePath, now: () => 20 });
			assert.equal(restored.resolve("run-a:0", "another-session").agent, "worker");
			assert.equal(restored.resolve("worker", "parent-a").originalTarget, "run-a:0");
			assert.throws(() => restored.resolve("worker", "parent-b"), /current parent session/);
			const raw = fs.readFileSync(filePath, "utf-8");
			assert.doesNotMatch(raw, /transcript content/);
			assert.equal(JSON.parse(raw).version, 1);
		} finally { removeTempDir(dir); }
	});

	it("keeps the original target and handle while advancing the latest turn locator", () => {
		const dir = createTempDir("child-registry-turn-");
		try {
			const registry = new ChildThreadRegistry({ filePath: path.join(dir, "registry.json") });
			registry.register({ originalTarget: "original:2", handle: "reviewer", parentSessionId: "parent", runId: "original", index: 2, state: "complete", cwd: dir, agent: "reviewer" });
			registry.update("parent", "original:2", { latestRunId: "continued", latestIndex: 0, state: "running", turn: 1 });
			assert.equal(registry.resolve("original:2", "parent").latestRunId, "continued");
			assert.equal(registry.resolve("continued:0", "other").originalTarget, "original:2");
			assert.equal(registry.resolve("reviewer", "parent").turn, 1);
		} finally { removeTempDir(dir); }
	});

	it("serializes child-process writers without losing records", async () => {
		const dir = createTempDir("child-registry-processes-");
		try {
			const filePath = path.join(dir, "registry.json");
			const script = `import { ChildThreadRegistry } from ${JSON.stringify(registryModuleUrl)};\nconst [filePath, cwd, offsetText] = process.argv.slice(1);\nconst offset = Number(offsetText);\nconst registry = new ChildThreadRegistry({ filePath });\nfor (let batch = 0; batch < 10; batch++) registry.registerMany(Array.from({ length: 10 }, (_, i) => { const index = offset + batch * 10 + i; return { originalTarget: 'shared-' + index + ':0', parentSessionId: 'parent', runId: 'shared-' + index, index: 0, state: 'queued', cwd, agent: 'worker' }; }));`;
			await Promise.all([0, 100, 200, 300].map((offset) => runRegistryChild(script, [filePath, dir, String(offset)])));
			assert.equal(new ChildThreadRegistry({ filePath }).list("parent").length, 400);
		} finally { removeTempDir(dir); }
	});

	it("validates handle collisions and inserts a group atomically", () => {
		const dir = createTempDir("child-registry-group-");
		try {
			const registry = new ChildThreadRegistry({ filePath: path.join(dir, "registry.json") });
			registry.register({ originalTarget: "old:0", handle: "taken", parentSessionId: "parent", runId: "old", index: 0, state: "complete", cwd: dir, agent: "worker" });
			assert.throws(() => registry.registerMany([
				{ originalTarget: "new:0", handle: "free", parentSessionId: "parent", runId: "new", index: 0, state: "queued", cwd: dir, agent: "worker" },
				{ originalTarget: "new:1", handle: "taken", parentSessionId: "parent", runId: "new", index: 1, state: "queued", cwd: dir, agent: "worker" },
			]), /collides/);
			assert.deepEqual(registry.list("parent").map((record) => record.originalTarget), ["old:0"]);
		} finally { removeTempDir(dir); }
	});

	it("allows only one child process to claim a settled continuation", async () => {
		const dir = createTempDir("child-registry-claim-");
		try {
			const filePath = path.join(dir, "registry.json");
			new ChildThreadRegistry({ filePath }).register({ originalTarget: "settled:0", parentSessionId: "parent", runId: "settled", index: 0, state: "complete", cwd: dir, agent: "worker" });
			const winners = path.join(dir, "winners.log");
			const script = `import fs from 'node:fs'; import { ChildThreadRegistry } from ${JSON.stringify(registryModuleUrl)};\nconst [filePath, winners] = process.argv.slice(1);\nconst claim = new ChildThreadRegistry({ filePath }).claimContinuation('parent', 'settled:0', 'planned-next');\nif (claim) fs.appendFileSync(winners, process.pid + '\\n');`;
			await Promise.all([runRegistryChild(script, [filePath, winners]), runRegistryChild(script, [filePath, winners])]);
			assert.equal(fs.readFileSync(winners, "utf-8").trim().split(/\n/).length, 1);
		} finally { removeTempDir(dir); }
	});

	it("bounds lock waits and recovers only stale dead contenders", () => {
		const dir = createTempDir("child-registry-stale-lock-");
		try {
			const filePath = path.join(dir, "registry.json");
			const lockDir = `${filePath}.lock`;
			fs.mkdirSync(lockDir, { recursive: true });
			const blocker = path.join(lockDir, "0000000000000000-blocker.json");
			fs.writeFileSync(blocker, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
			const bounded = new ChildThreadRegistry({ filePath, lockTimeoutMs: 20, staleLockMs: 1 });
			assert.throws(() => bounded.register({ originalTarget: "blocked:0", parentSessionId: "parent", runId: "blocked", index: 0, state: "queued", cwd: dir, agent: "worker" }), /Timed out waiting/);
			fs.writeFileSync(blocker, JSON.stringify({ pid: 99_999_999, createdAt: 0 }));
			const recovered = new ChildThreadRegistry({ filePath, lockTimeoutMs: 100, staleLockMs: 1 });
			recovered.register({ originalTarget: "recovered:0", parentSessionId: "parent", runId: "recovered", index: 0, state: "queued", cwd: dir, agent: "worker" });
			assert.equal(recovered.resolve("recovered:0", "parent").agent, "worker");
			assert.equal(fs.existsSync(blocker), false);
		} finally { removeTempDir(dir); }
	});

	it("keeps stale continuation claims while the claimant pid is live, but bounds PID-reuse blocking", () => {
		const dir = createTempDir("child-registry-stale-claim-");
		try {
			const filePath = path.join(dir, "registry.json");
			let now = Date.now();
			const registry = new ChildThreadRegistry({ filePath, now: () => now, staleClaimMs: 1, hardStaleClaimMs: 100 });
			registry.register({ originalTarget: "settled:0", parentSessionId: "parent", runId: "settled", index: 0, state: "complete", cwd: dir, agent: "worker" });
			const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			raw.sessions.parent.records["settled:0"].continuationClaim = { token: "old", pid: process.pid, claimedAt: now - 10, nextRunId: "planned-old" };
			fs.writeFileSync(filePath, JSON.stringify(raw));
			assert.equal(registry.claimContinuation("parent", "settled:0", "planned-next"), undefined);
			now += 101;
			assert.ok(registry.claimContinuation("parent", "settled:0", "planned-next"));
		} finally { removeTempDir(dir); }
	});

	it("conditionally ignores stale completion updates after a continuation advances", () => {
		const dir = createTempDir("child-registry-locator-race-");
		try {
			const registry = new ChildThreadRegistry({ filePath: path.join(dir, "registry.json") });
			registry.register({ originalTarget: "old:0", parentSessionId: "parent", runId: "old", index: 0, state: "running", cwd: dir, agent: "worker", asyncDir: path.join(dir, "old") });
			registry.update("parent", "old:0", { latestRunId: "next", latestIndex: 0, state: "running", asyncDir: path.join(dir, "next") });
			const stale = registry.updateIfLatest("parent", "old:0", { latestRunId: "old", latestIndex: 0 }, { state: "complete", asyncDir: path.join(dir, "old") });
			assert.equal(stale, undefined);
			assert.deepEqual(
				{ latestRunId: registry.resolve("old:0", "parent").latestRunId, state: registry.resolve("old:0", "parent").state, asyncDir: registry.resolve("old:0", "parent").asyncDir },
				{ latestRunId: "next", state: "running", asyncDir: path.join(dir, "next") },
			);
		} finally { removeTempDir(dir); }
	});

	it("does not let async launch annotation overwrite a fast terminal update", () => {
		const dir = createTempDir("child-registry-fast-complete-");
		try {
			const registry = new ChildThreadRegistry({ filePath: path.join(dir, "registry.json") });
			registry.register({ originalTarget: "fast:0", parentSessionId: "parent", runId: "fast", index: 0, state: "queued", cwd: dir, agent: "worker" });
			registry.updateIfLatest("parent", "fast:0", { latestRunId: "fast", latestIndex: 0 }, { state: "complete" });
			const staleLaunch = registry.updateIfLatestInStates("parent", "fast:0", { latestRunId: "fast", latestIndex: 0 }, ["queued", "running"], { state: "running" });
			assert.equal(staleLaunch, undefined);
			assert.equal(registry.resolve("fast:0", "parent").state, "complete");
		} finally { removeTempDir(dir); }
	});

	it("reconciles a claimed planned run exactly once", () => {
		const dir = createTempDir("child-registry-reconcile-");
		try {
			const registry = new ChildThreadRegistry({ filePath: path.join(dir, "registry.json") });
			registry.register({ originalTarget: "old:0", parentSessionId: "parent", runId: "old", index: 0, state: "complete", cwd: dir, agent: "worker" });
			assert.ok(registry.claimContinuation("parent", "old:0", "planned"));
			const reconciled = registry.reconcileContinuation("parent", "old:0", "planned", { latestIndex: 0, state: "running", asyncDir: path.join(dir, "planned") });
			assert.equal(reconciled?.latestRunId, "planned");
			assert.equal(reconciled?.turn, 1);
			assert.equal(registry.reconcileContinuation("parent", "old:0", "planned", { latestIndex: 0, state: "complete" }), undefined);
			assert.equal(registry.resolve("old:0", "parent").turn, 1);
		} finally { removeTempDir(dir); }
	});

	it("ignores malformed records and quarantines invalid top-level data on mutation", () => {
		const dir = createTempDir("child-registry-invalid-");
		try {
			const filePath = path.join(dir, "registry.json");
			fs.writeFileSync(filePath, JSON.stringify({ version: 1, sessions: { parent: { records: { "bad:0": { originalTarget: "bad:0" } } } } }));
			const registry = new ChildThreadRegistry({ filePath });
			assert.deepEqual(registry.list(), []);
			fs.writeFileSync(filePath, "not-json");
			registry.register({ originalTarget: "good:0", parentSessionId: "parent", runId: "good", index: 0, state: "queued", cwd: dir, agent: "worker" });
			assert.equal(registry.resolve("good:0", "parent").agent, "worker");
			assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("registry.json.invalid-")));
		} finally { removeTempDir(dir); }
	});
});
