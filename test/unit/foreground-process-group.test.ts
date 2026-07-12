import assert from "node:assert/strict";
import test from "node:test";
import { backgroundWorkSupervisorState, foregroundSpawnDetached, isBackgroundWorkPromoted, shouldDetachForIntercomAbort, signalForegroundProcessTree } from "../../src/runs/foreground/process-group.ts";

test("Unix foreground children use and signal their process group", () => {
	const signals: Array<[number, NodeJS.Signals]> = [];
	let direct = 0;
	const child = { pid: 321, kill() { direct += 1; return true; } };
	assert.equal(foregroundSpawnDetached("darwin"), true);
	assert.equal(signalForegroundProcessTree(child as never, "SIGTERM", "darwin", ((pid: number, signal: NodeJS.Signals) => {
		signals.push([pid, signal]);
		return true;
	}) as typeof process.kill), true);
	assert.deepEqual(signals, [[-321, "SIGTERM"]]);
	assert.equal(direct, 0);
});

test("promoted hard cancellation bypasses intercom detach", () => {
	const controller = new AbortController();
	const signal = controller.signal as AbortSignal & { backgroundWorkPromoted?: boolean };
	assert.equal(shouldDetachForIntercomAbort(signal, true, true), true);
	signal.backgroundWorkPromoted = true;
	assert.equal(isBackgroundWorkPromoted(signal), true);
	assert.equal(shouldDetachForIntercomAbort(signal, true, true), false);
	controller.abort(Object.assign(new Error("hard cancel"), { backgroundWorkHardCancel: true }));
	assert.equal(shouldDetachForIntercomAbort(signal, true, true), false);
});

test("supervisor state carries the exact coordinator session identity", () => {
	const signal = Object.assign(new AbortController().signal, { backgroundWorkSessionId: "session-authoritative" });
	assert.deepEqual(backgroundWorkSupervisorState(signal, true, "request-1"), { pending: true, requestId: "request-1", sessionId: "session-authoritative" });
});

test("Windows and missing Unix groups fall back to direct child signaling", () => {
	let direct = 0;
	const child = { pid: 321, kill(signal: NodeJS.Signals) { direct += 1; return signal === "SIGKILL"; } };
	assert.equal(foregroundSpawnDetached("win32"), false);
	assert.equal(signalForegroundProcessTree(child as never, "SIGKILL", "win32"), true);
	assert.equal(signalForegroundProcessTree(child as never, "SIGKILL", "linux", (() => { throw new Error("gone"); }) as typeof process.kill), true);
	assert.equal(direct, 2);
});
