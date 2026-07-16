/**
 * Real Pi-session end-to-end test for the subagent extension.
 *
 * Spawns an actual child `pi` subprocess (a repo-local child CLI that runs a
 * real `AgentSession` backed by a faux provider) and exercises the extension's
 * real foreground execution path: the parent session calls the `subagent` tool,
 * the tool spawns the child, the child streams jsonl events, the extension's
 * real stdout parser extracts the result, and the marker flows back as a tool
 * result that the parent relays. No real API keys are used.
 *
 * Skips gracefully when the pi runtime packages are not importable.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { ChildThreadRegistry, childThreadRegistryPath } from "../../src/runs/shared/child-thread-registry.ts";
import { tryImport } from "../support/helpers.ts";
import type { RealSessionRun } from "../support/real-session-runner.ts";

const piCodingAgent = await tryImport<unknown>("@earendil-works/pi-coding-agent");
const piAi = await tryImport<unknown>("@earendil-works/pi-ai");
const available = Boolean(piCodingAgent && piAi);

const CHILD_MARKER = "CHILD_REAL_SESSION_OK";
// Env vars the runner must clear so a parent that was itself spawned as a
// subagent child can still launch fresh children. The values are deliberately
// bogus sentinels (nonexistent paths) so a leaked value would break spawning.
const BOGUS_EXTRA_DIRS = path.join(os.tmpdir(), "nonexistent-pi-subagents-e2e-extra-dirs");
const BOGUS_PI_BINARY = path.join(os.tmpdir(), "nonexistent-pi-binary-e2e");
const BOGUS_PI_PACKAGE_ROOT = path.join(os.tmpdir(), "nonexistent-pi-coding-agent-package-root-e2e");
function latestToolResultText(messages: Array<{ role?: string; toolName?: string; content?: unknown }>, toolName: string): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role !== "toolResult" || message.toolName !== toolName || !Array.isArray(message.content)) continue;
		return message.content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
			? [String((part as { text?: unknown }).text ?? "")]
			: []).join("");
	}
	return undefined;
}

const ISOLATED_ENV_KEYS = [
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_FANOUT_CHILD",
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_PARENT_SESSION",
	"PI_SUBAGENT_PI_BINARY",
	"PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
] as const;

describe("real Pi-session subagent E2E", { skip: !available ? "pi runtime packages not available" : undefined }, () => {
	let run: RealSessionRun | undefined;

	afterEach(async () => {
		await run?.dispose();
		run = undefined;
	});

	it("boots the extension in a real parent session and delivers a faux child result", async () => {
		const { routeParentThroughSubagent, runRealSubagentSession, subagentToolResults } = await import("../support/real-session-runner.ts");

		const previousEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_FANOUT_CHILD = "1";
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "1";
		process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = BOGUS_EXTRA_DIRS;
		process.env.PI_SUBAGENT_PARENT_SESSION = "polluted-parent";
		process.env.PI_SUBAGENT_PI_BINARY = BOGUS_PI_BINARY;
		process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = BOGUS_PI_PACKAGE_ROOT;

		try {
			run = await runRealSubagentSession({
				prompt: "Delegate to a worker and report its exact result.",
				childText: CHILD_MARKER,
				respond: routeParentThroughSubagent({
					childMarker: CHILD_MARKER,
					subagentArgs: {
						agent: "worker",
						task: "Return the marker from the faux child provider.",
						context: "fresh",
						agentScope: "project",
					},
				}),
			});

			const toolResults = subagentToolResults(run.parentSession);
			assert.equal(toolResults.length, 1);
			assert.match(toolResults[0]!, new RegExp(CHILD_MARKER));
			assert.match(run.responseText, new RegExp(CHILD_MARKER));
			assert.doesNotMatch(run.responseText, /CHILD_MISSING/);
			assert.ok(run.modelCalls >= 2, `expected parent tool-call and final turns, got ${run.modelCalls}`);
		} finally {
			await run?.dispose();
			run = undefined;
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("continues a settled named child through its exact persisted session", async () => {
		const { runRealSubagentSession, subagentCall } = await import("../support/real-session-runner.ts");
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const initialMarker = "CHILD_INITIAL_TURN_OK";
		const continuationMarker = "CHILD_CONTINUATION_TURN_OK";

		run = await runRealSubagentSession({
			prompt: "Launch the named child, continue it, wait for completion, then report success.",
			childText: initialMarker,
			continuationText: continuationMarker,
			timeoutMs: 60_000,
			respond: (context) => {
				const messages = context.messages as Array<{ role?: string; toolName?: string; content?: unknown }>;
				if (latestToolResultText(messages, "wait") !== undefined) return "CONTINUATION_WAITED";
				if (latestToolResultText(messages, "send_message") !== undefined) {
					return { type: "toolCall", id: "call-wait-e2e", name: "wait", arguments: { all: true } };
				}
				if (latestToolResultText(messages, "subagent") !== undefined) {
					return { type: "toolCall", id: "call-send-message-e2e", name: "send_message", arguments: { target: "thread", message: "Return the continuation marker." } };
				}
				return subagentCall({
					agent: "worker",
					handle: "thread",
					task: "Return the initial marker from the faux child provider.",
					context: "fresh",
					agentScope: "project",
				}, "call-initial-child-e2e");
			},
		});

		const parentSessionId = run.parentSession.sessionManager.getSessionId();
		assert.ok(parentSessionId);
		const record = new ChildThreadRegistry({ filePath: childThreadRegistryPath(run.agentDir) }).resolve("thread", parentSessionId);
		assert.equal(record.handle, "thread");
		assert.equal(record.turn, 1);
		assert.ok(record.sessionFile);
		const transcript = JSON.stringify(SessionManager.open(record.sessionFile).getBranch());
		assert.match(transcript, new RegExp(initialMarker));
		assert.match(transcript, new RegExp(continuationMarker));
		assert.doesNotMatch(transcript, /CHILD_CONTINUATION_CONTEXT_MISSING/);
		assert.match(latestToolResultText(run.parentSession.messages, "send_message") ?? "", /Child thread: thread=/);
		assert.notEqual(latestToolResultText(run.parentSession.messages, "wait"), undefined);
		assert.equal(run.responseText, "CONTINUATION_WAITED");
	});
});
