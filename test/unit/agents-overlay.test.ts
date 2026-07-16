import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SessionManager, initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { validateChildSessionFile } from "../../src/extension/send-message.ts";
import { AgentsOverlay, registerAgentsCommand } from "../../src/tui/agents-overlay.ts";
import { ChildThreadRegistry, sessionOwnershipSidecarPath } from "../../src/runs/shared/child-thread-registry.ts";

initTheme(undefined, false);

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
	} as unknown as Theme;
}

function fakeTui(rows = 30): { tui: TUI; renders: () => number } {
	let renderCount = 0;
	return {
		tui: {
			terminal: { rows },
			requestRender() { renderCount++; },
		} as unknown as TUI,
		renders: () => renderCount,
	};
}

function createRegistry(root: string): ChildThreadRegistry {
	let now = 1_000;
	return new ChildThreadRegistry({ filePath: path.join(root, "registry.json"), now: () => ++now });
}

function registerThread(registry: ChildThreadRegistry, input: {
	parentSessionId: string;
	runId: string;
	agent: string;
	handle?: string;
	sessionFile?: string;
	cwd: string;
	state?: "running" | "complete";
}): void {
	registry.register({
		originalTarget: `${input.runId}:0`,
		parentSessionId: input.parentSessionId,
		runId: input.runId,
		index: 0,
		state: input.state ?? "complete",
		cwd: input.cwd,
		agent: input.agent,
		handle: input.handle,
		sessionFile: input.sessionFile,
	});
}

describe("agents overlay", () => {
	it("defaults to current-session threads and Tab toggles all-session history", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-list-"));
		try {
			const registry = createRegistry(root);
			registerThread(registry, { parentSessionId: "parent-current", runId: "11111111-1111-4111-8111-111111111111", agent: "reviewer", handle: "audit", cwd: root });
			registerThread(registry, { parentSessionId: "parent-old", runId: "22222222-2222-4222-8222-222222222222", agent: "scout", handle: "history", cwd: root });
			const { tui } = fakeTui();
			let closed = false;
			const overlay = new AgentsOverlay(tui, fakeTheme(), () => { closed = true; }, {
				registry,
				parentSessionId: "parent-current",
				trustedSessionRoots: () => [root],
				pollIntervalMs: 0,
				now: () => 1_001,
			});

			const current = overlay.render(110).map(stripAnsi).join("\n");
			assert.match(current, /current session \(1\)/);
			assert.match(current, /audit/);
			assert.doesNotMatch(current, /22222222-2222-4222-8222-222222222222/);

			overlay.handleInput("\t");
			const all = overlay.render(110).map(stripAnsi).join("\n");
			assert.match(all, /all sessions \(2\)/);
			assert.match(all, /audit/);
			assert.match(all, /history/);

			overlay.handleInput("q");
			assert.equal(closed, true);
			overlay.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the selected thread stable when metadata updates reorder the list", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-selection-"));
		try {
			const registry = createRegistry(root);
			registerThread(registry, { parentSessionId: "parent-current", runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", agent: "worker", handle: "alpha", cwd: root });
			registerThread(registry, { parentSessionId: "parent-current", runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", agent: "reviewer", handle: "beta", cwd: root });
			const { tui } = fakeTui();
			const overlay = new AgentsOverlay(tui, fakeTheme(), () => {}, {
				registry,
				parentSessionId: "parent-current",
				trustedSessionRoots: () => [root],
				pollIntervalMs: 10,
			});

			overlay.handleInput("j");
			registry.update("parent-current", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:0", { state: "running" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			const selected = overlay.render(110).map(stripAnsi).find((line) => line.includes("›"));
			assert.match(selected ?? "", /alpha/);
			overlay.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("renders persisted messages and tool results, then refreshes appended entries", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-transcript-"));
		try {
			const sessions = path.join(root, "sessions");
			const manager = SessionManager.create(root, sessions);
			manager.appendMessage({ role: "user", content: "Inspect the file" });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "notes.txt" } }],
				stopReason: "toolUse",
			});
			const sessionFile = manager.getSessionFile();
			assert.ok(sessionFile);
			const registry = createRegistry(root);
			registerThread(registry, {
				parentSessionId: "parent-current",
				runId: "33333333-3333-4333-8333-333333333333",
				agent: "worker",
				handle: "builder",
				cwd: root,
				sessionFile,
			});
			const { tui, renders } = fakeTui(40);
			const overlay = new AgentsOverlay(tui, fakeTheme(), () => {}, {
				registry,
				parentSessionId: "parent-current",
				trustedSessionRoots: () => [sessions],
				pollIntervalMs: 10,
			});

			overlay.handleInput("\r");
			const initial = overlay.render(110).map(stripAnsi).join("\n");
			assert.match(initial, /Inspect the file/);
			assert.match(initial, /read/);
			assert.doesNotMatch(initial, /file contents/);

			manager.appendMessage({
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
			});
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fresh live update" }], stopReason: "stop" });
			await new Promise((resolve) => setTimeout(resolve, 40));
			const refreshedRaw = overlay.render(110).join("\n");
			const refreshed = stripAnsi(refreshedRaw);
			assert.match(refreshed, /file contents/);
			assert.match(refreshed, /Fresh live update/);
			assert.ok(renders() > 0);

			overlay.handleInput("\x1b");
			assert.match(overlay.render(110).map(stripAnsi).join("\n"), /current session/);
			overlay.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the last good transcript while a trailing JSONL entry is incomplete", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-partial-"));
		try {
			const sessions = path.join(root, "sessions");
			const manager = SessionManager.create(root, sessions);
			manager.appendMessage({ role: "user", content: "Stable transcript" });
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Before partial write" }], stopReason: "stop" });
			const sessionFile = manager.getSessionFile();
			assert.ok(sessionFile);
			const registry = createRegistry(root);
			registerThread(registry, { parentSessionId: "parent-current", runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", agent: "worker", cwd: root, sessionFile });
			const { tui } = fakeTui(40);
			const overlay = new AgentsOverlay(tui, fakeTheme(), () => {}, {
				registry,
				parentSessionId: "parent-current",
				trustedSessionRoots: () => [sessions],
				pollIntervalMs: 10,
			});
			overlay.handleInput("\r");
			const validContents = fs.readFileSync(sessionFile, "utf-8");
			fs.appendFileSync(sessionFile, '{"type":"message"');
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.match(overlay.render(110).map(stripAnsi).join("\n"), /Before partial write/);

			fs.writeFileSync(sessionFile, validContents);
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Recovered append" }], stopReason: "stop" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.match(overlay.render(110).map(stripAnsi).join("\n"), /Recovered append/);
			overlay.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads an active runtime session without weakening settled ownership checks", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-active-session-"));
		try {
			const sessions = path.join(root, "sessions");
			const manager = SessionManager.create(root, sessions);
			manager.appendMessage({ role: "user", content: "live" });
			manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "stop" });
			const sessionFile = manager.getSessionFile();
			assert.ok(sessionFile);
			const registry = createRegistry(root);
			const record = registry.register({
				originalTarget: "44444444-4444-4444-8444-444444444444:0",
				parentSessionId: "parent-current",
				runId: "44444444-4444-4444-8444-444444444444",
				index: 0,
				state: "running",
				cwd: root,
				agent: "worker",
				sessionFile,
			});
			fs.rmSync(sessionOwnershipSidecarPath(sessionFile), { force: true });

			assert.equal(validateChildSessionFile(record, [sessions], { allowActiveRuntimeRoot: true }), fs.realpathSync(sessionFile));
			assert.throws(
				() => validateChildSessionFile({ ...record, state: "complete" }, [sessions], { allowActiveRuntimeRoot: true }),
				/durable ownership evidence/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("strips terminal control sequences from persisted user, assistant, and bash content", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-transcript-sanitize-"));
		try {
			const sessions = path.join(root, "sessions");
			const manager = SessionManager.create(root, sessions);
			manager.appendMessage({ role: "user", content: "user-safe\x1b]52;c;dXNlci1jbGlwYm9hcmQ=\x07" });
			manager.appendMessage({
				role: "assistant",
				content: [
					{ type: "text", text: "assistant-safe\x1b[2J" },
					{ type: "toolCall", id: "unsafe-call", name: "custom_tool", arguments: { "path\x1b[2J": "notes\x1b[3J.txt" } },
				],
				stopReason: "toolUse",
			});
			const sessionFile = manager.getSessionFile();
			assert.ok(sessionFile);
			const registry = createRegistry(root);
			registerThread(registry, {
				parentSessionId: "parent-current",
				runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
				agent: "worker",
				cwd: root,
				sessionFile,
			});
			const { tui } = fakeTui(200);
			const overlay = new AgentsOverlay(tui, fakeTheme(), () => {}, {
				registry,
				parentSessionId: "parent-current",
				trustedSessionRoots: () => [sessions],
				pollIntervalMs: 10,
			});

			overlay.handleInput("\r");
			assert.match(stripAnsi(overlay.render(120).join("\n")), /user-safe/);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "unsafe-call",
				toolName: "custom_tool",
				content: [{ type: "text", text: "tool-safe\x1b]52;c;dG9vbC1vdXRwdXQ=\x07" }],
				isError: false,
			});
			manager.appendMessage({
				role: "bashExecution",
				command: "printf bash-safe\x1b[3J",
				output: "bash-safe\x1b]52;c;YmFzaC1vdXRwdXQ=\x07",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			});
			await new Promise((resolve) => setTimeout(resolve, 40));
			const rendered = overlay.render(120).join("\n");
			assert.doesNotMatch(rendered, /\x1b\]52|\x1b\[(?:2J|3J)|dXNlci1jbGlwYm9hcmQ=|dG9vbC1vdXRwdXQ=|YmFzaC1vdXRwdXQ=/);
			for (const text of ["user-safe", "assistant-safe", "tool-safe", "bash-safe"]) assert.match(stripAnsi(rendered), new RegExp(text));
			overlay.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("strips terminal control sequences from registry metadata and validation errors", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-sanitize-"));
		try {
			const registry = createRegistry(root);
			registerThread(registry, {
				parentSessionId: "parent-current",
				runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
				agent: "worker\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[31mred",
				cwd: `${root}/child\n\x1b[2Jcwd`,
				sessionFile: `${root}/missing-\x1b]52;c;c2VjcmV0\x07.jsonl`,
			});
			const { tui } = fakeTui();
			const overlay = new AgentsOverlay(tui, fakeTheme(), () => {}, {
				registry,
				parentSessionId: "parent-current",
				trustedSessionRoots: () => [root],
				pollIntervalMs: 0,
			});
			overlay.handleInput("\r");
			const rendered = overlay.render(110);
			assert.doesNotMatch(rendered.join(""), /\x1b\]|\x1b\[(?:31m|2J)|Y2xpcGJvYXJk|c2VjcmV0/);
			const lines = rendered.map(stripAnsi);
			for (const line of lines) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
			assert.match(lines.join(""), /workerred/);
			overlay.dispose();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("stops polling when the overlay is disposed", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-dispose-"));
		try {
			const { tui, renders } = fakeTui();
			const overlay = new AgentsOverlay(tui, fakeTheme(), () => {}, {
				registry: createRegistry(root),
				parentSessionId: "parent-current",
				trustedSessionRoots: () => [root],
				pollIntervalMs: 5,
			});
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.ok(renders() > 0);
			overlay.dispose();
			const stoppedAt = renders();
			await new Promise((resolve) => setTimeout(resolve, 25));
			assert.equal(renders(), stoppedAt);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers /agents only for TUI mode", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-overlay-command-"));
		try {
			const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
			registerAgentsCommand({
				registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) { commands.set(name, command); },
			} as never, {
				registry: createRegistry(root),
				trustedSessionRoots: () => [root],
			});
			for (const mode of ["rpc", "json", "print"] as const) {
				const notifications: string[] = [];
				let customCalls = 0;
				await commands.get("agents")!.handler("", {
					mode,
					hasUI: mode === "rpc",
					ui: {
						notify(message: string) { notifications.push(message); },
						async custom() { customCalls++; },
					},
					sessionManager: { getSessionId: () => "parent-current" },
				} as unknown as ExtensionContext);
				assert.deepEqual(notifications, ["/agents requires interactive mode."]);
				assert.equal(customCalls, 0);
			}

			let tuiCustomCalls = 0;
			await commands.get("agents")!.handler("", {
				mode: "tui",
				hasUI: true,
				ui: {
					notify() {},
					async custom() { tuiCustomCalls++; },
				},
				sessionManager: { getSessionId: () => "parent-current" },
			} as unknown as ExtensionContext);
			assert.equal(tuiCustomCalls, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
