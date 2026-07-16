import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomMessageComponent,
	SessionManager,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { validateChildSessionFile } from "../extension/send-message.ts";
import { ChildThreadRegistry, type ChildThreadRecord, type ChildThreadState } from "../runs/shared/child-thread-registry.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TERMINAL_STRING_SEQUENCE = /(?:\x1b[P_\]^]|[\x90\x98\x9d-\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c)/gi;
const TERMINAL_CSI_SEQUENCE = /[\x1b\x9b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

type AgentsScope = "current" | "all";
type AgentsView = "list" | "transcript";

export interface AgentsOverlayOptions {
	registry: ChildThreadRegistry;
	parentSessionId: string;
	trustedSessionRoots: () => string[];
	pollIntervalMs?: number;
	now?: () => number;
}

export interface AgentsCommandOptions {
	registry: ChildThreadRegistry;
	trustedSessionRoots: () => string[];
	currentSessionId?: (ctx: ExtensionContext) => string | null | undefined;
}

export function sanitizeTerminalContent(value: string): string {
	return value
		.replace(TERMINAL_STRING_SEQUENCE, "")
		.replace(TERMINAL_CSI_SEQUENCE, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function sanitizeTerminalMetadata(value: string): string {
	return sanitizeTerminalContent(value)
		.replace(/[\t\n]+/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function sanitizeTerminalValue(value: unknown): unknown {
	if (typeof value === "string") return sanitizeTerminalContent(value);
	if (Array.isArray(value)) return value.map(sanitizeTerminalValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, child]) => [sanitizeTerminalContent(key), sanitizeTerminalValue(child)]));
}

function sanitizeAgentMessage(message: AgentMessage): AgentMessage {
	return sanitizeTerminalValue(message) as AgentMessage;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const block = part as { type?: unknown; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") return [block.text];
		if (block.type === "image") return ["[image]"];
		return [];
	}).join("\n");
}

function sameRecord(left: ChildThreadRecord | undefined, right: ChildThreadRecord | undefined): boolean {
	return Boolean(left && right && left.parentSessionId === right.parentSessionId && left.originalTarget === right.originalTarget);
}

function stateStyle(state: ChildThreadState, frame: number): { glyph: string; color: "dim" | "accent" | "success" | "error" | "warning" } {
	switch (state) {
		case "queued": return { glyph: "·", color: "dim" };
		case "running": return { glyph: SPINNER[frame % SPINNER.length]!, color: "accent" };
		case "complete": return { glyph: "✓", color: "success" };
		case "failed": return { glyph: "×", color: "error" };
		case "paused": return { glyph: "‖", color: "warning" };
		case "detached": return { glyph: "↗", color: "warning" };
	}
}

function ageLabel(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 1) return "now";
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export class AgentsOverlay implements Component {
	private scope: AgentsScope = "current";
	private view: AgentsView = "list";
	private records: ChildThreadRecord[] = [];
	private selectedIndex = 0;
	private transcriptRecord?: ChildThreadRecord;
	private transcriptComponents: Component[] = [];
	private transcriptEntryIds: string[] = [];
	private transcriptTools = new Map<string, ToolExecutionComponent>();
	private transcriptSignature?: string;
	private transcriptError?: string;
	private transcriptScroll = 0;
	private frame = 0;
	private readonly now: () => number;
	private readonly timer?: ReturnType<typeof setInterval>;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly options: AgentsOverlayOptions;

	constructor(tui: TUI, theme: Theme, done: () => void, options: AgentsOverlayOptions) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.options = options;
		this.now = options.now ?? Date.now;
		this.refreshRecords();
		const pollIntervalMs = options.pollIntervalMs ?? 250;
		if (pollIntervalMs > 0) {
			this.timer = setInterval(() => this.poll(), pollIntervalMs);
			this.timer.unref?.();
		}
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
	}

	invalidate(): void {
		for (const component of this.transcriptComponents) component.invalidate?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || data === "q") {
			if (this.view === "transcript") {
				this.view = "list";
				this.transcriptScroll = 0;
				this.tui.requestRender();
				return;
			}
			this.done();
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.view = "list";
			this.scope = this.scope === "current" ? "all" : "current";
			this.refreshRecords();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			if (this.view === "list") this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			else this.transcriptScroll++;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			if (this.view === "list") this.selectedIndex = Math.min(Math.max(0, this.records.length - 1), this.selectedIndex + 1);
			else this.transcriptScroll = Math.max(0, this.transcriptScroll - 1);
			this.tui.requestRender();
			return;
		}
		if (this.view === "transcript" && matchesKey(data, Key.pageUp)) {
			this.transcriptScroll += Math.max(1, this.bodyHeight() - 2);
			this.tui.requestRender();
			return;
		}
		if (this.view === "transcript" && matchesKey(data, Key.pageDown)) {
			this.transcriptScroll = Math.max(0, this.transcriptScroll - Math.max(1, this.bodyHeight() - 2));
			this.tui.requestRender();
			return;
		}
		if (this.view === "list" && matchesKey(data, Key.enter)) {
			const record = this.records[this.selectedIndex];
			if (!record) return;
			this.transcriptRecord = record;
			this.view = "transcript";
			this.transcriptScroll = 0;
			this.refreshTranscript(record, true);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth("Agents", width)];
		return this.view === "list" ? this.renderList(width) : this.renderTranscript(width);
	}

	private poll(): void {
		this.frame = (this.frame + 1) % SPINNER.length;
		this.refreshRecords();
		if (this.transcriptRecord) this.refreshTranscript(this.transcriptRecord);
		this.tui.requestRender();
	}

	private refreshRecords(): void {
		const selected = this.view === "list" ? this.records[this.selectedIndex] : this.transcriptRecord;
		this.records = this.options.registry.list(this.scope === "current" ? this.options.parentSessionId : undefined);
		if (selected) {
			const nextIndex = this.records.findIndex((record) => sameRecord(record, selected));
			if (nextIndex >= 0) this.selectedIndex = nextIndex;
		}
		this.selectedIndex = Math.min(Math.max(0, this.records.length - 1), this.selectedIndex);
		if (this.transcriptRecord) {
			const current = this.options.registry.list(this.transcriptRecord.parentSessionId)
				.find((record) => record.originalTarget === this.transcriptRecord!.originalTarget);
			if (current) this.transcriptRecord = current;
		}
	}

	private refreshTranscript(record: ChildThreadRecord, force = false): void {
		try {
			const sessionFile = validateChildSessionFile(record, this.options.trustedSessionRoots(), { allowActiveRuntimeRoot: true });
			const stat = fs.statSync(sessionFile);
			const signature = `${sessionFile}:${stat.size}:${stat.mtimeMs}`;
			if (!force && signature === this.transcriptSignature) return;
			const manager = SessionManager.open(sessionFile, path.dirname(sessionFile), record.cwd);
			const entries = manager.getBranch();
			const isAppend = this.transcriptEntryIds.length <= entries.length
				&& this.transcriptEntryIds.every((id, index) => entries[index]?.id === id);
			if (!isAppend) this.resetTranscript();
			for (const entry of entries.slice(this.transcriptEntryIds.length)) this.appendEntry(entry);
			this.transcriptEntryIds = entries.map((entry) => entry.id);
			this.transcriptSignature = signature;
			this.transcriptError = undefined;
		} catch (error) {
			this.transcriptError = error instanceof Error ? error.message : String(error);
		}
	}

	private resetTranscript(): void {
		this.transcriptComponents = [];
		this.transcriptEntryIds = [];
		this.transcriptTools.clear();
		this.transcriptSignature = undefined;
	}

	private appendEntry(entry: SessionEntry): void {
		for (const message of sessionEntryToContextMessages(entry)) this.appendMessage(message);
	}

	private appendMessage(message: AgentMessage): void {
		const safeMessage = sanitizeAgentMessage(message);
		switch (safeMessage.role) {
			case "user": {
				this.transcriptComponents.push(new UserMessageComponent(contentText(safeMessage.content), getMarkdownTheme(), 0));
				break;
			}
			case "assistant": {
				this.transcriptComponents.push(new AssistantMessageComponent(safeMessage, false, getMarkdownTheme(), "Thinking", 0));
				for (const block of safeMessage.content) {
					if (block.type !== "toolCall") continue;
					const component = new ToolExecutionComponent(block.name, block.id, block.arguments, { showImages: false }, undefined, this.tui, this.transcriptRecord?.cwd ?? this.options.parentSessionId);
					component.setExpanded(true);
					component.setArgsComplete();
					if (safeMessage.stopReason === "aborted" || safeMessage.stopReason === "error") {
						component.updateResult({ content: [{ type: "text", text: safeMessage.stopReason === "aborted" ? "Aborted" : safeMessage.errorMessage ?? "Error" }], isError: true });
					} else {
						component.markExecutionStarted();
						this.transcriptTools.set(block.id, component);
					}
					this.transcriptComponents.push(component);
				}
				break;
			}
			case "toolResult": {
				const component = this.transcriptTools.get(safeMessage.toolCallId);
				if (component) {
					component.updateResult(safeMessage);
					this.transcriptTools.delete(safeMessage.toolCallId);
				}
				break;
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(safeMessage.command, this.tui, safeMessage.excludeFromContext);
				component.appendOutput(safeMessage.output);
				component.setComplete(safeMessage.exitCode, safeMessage.cancelled, undefined, safeMessage.fullOutputPath);
				component.setExpanded(true);
				this.transcriptComponents.push(component);
				break;
			}
			case "custom": {
				if (!safeMessage.display) break;
				const component = new CustomMessageComponent(safeMessage, undefined, getMarkdownTheme());
				component.setExpanded(true);
				this.transcriptComponents.push(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(safeMessage, getMarkdownTheme());
				component.setExpanded(true);
				this.transcriptComponents.push(component);
				break;
			}
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(safeMessage, getMarkdownTheme());
				component.setExpanded(true);
				this.transcriptComponents.push(component);
				break;
			}
		}
	}

	private renderList(width: number): string[] {
		const scopeLabel = this.scope === "current" ? "current session" : "all sessions";
		const lines = [this.header(` Agents · ${scopeLabel} (${this.records.length}) `, width), this.row("", width)];
		const bodyHeight = this.bodyHeight();
		if (this.records.length === 0) {
			lines.push(this.row(` ${this.theme.fg("dim", "No child threads found.")}`, width));
		} else {
			const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(bodyHeight / 2), this.records.length - bodyHeight));
			for (let index = start; index < Math.min(this.records.length, start + bodyHeight); index++) {
				const record = this.records[index]!;
				const selected = index === this.selectedIndex;
				const style = stateStyle(record.state, this.frame);
				const marker = selected ? this.theme.fg("accent", "›") : " ";
				const status = this.theme.fg(style.color, `${style.glyph} ${record.state.padEnd(8)}`);
				const safeName = sanitizeTerminalMetadata(record.handle ?? record.agent);
				const name = selected ? this.theme.fg("accent", this.theme.bold(safeName)) : safeName;
				const agent = record.handle ? this.theme.fg("dim", sanitizeTerminalMetadata(record.agent)) : "";
				const session = this.scope === "all" ? this.theme.fg("dim", `session ${sanitizeTerminalMetadata(record.parentSessionId).slice(0, 8)}`) : "";
				const details = [name, agent, sanitizeTerminalMetadata(record.originalTarget), `turn ${record.turn + 1}`, session, ageLabel(record.updatedAt, this.now())].filter(Boolean).join("  ");
				lines.push(this.row(` ${marker} ${status} ${details}`, width));
			}
		}
		lines.push(this.row("", width));
		lines.push(this.row(` ${this.theme.fg("dim", "↑/↓ j/k navigate  Enter transcript  Tab toggle history  Esc close")}`, width));
		lines.push(this.footer(width));
		return lines;
	}

	private renderTranscript(width: number): string[] {
		const record = this.transcriptRecord;
		if (!record) {
			this.view = "list";
			return this.renderList(width);
		}
		const title = record.handle ? `${sanitizeTerminalMetadata(record.handle)} · ${sanitizeTerminalMetadata(record.agent)}` : sanitizeTerminalMetadata(record.agent);
		const lines = [this.header(` Agent · ${title} `, width)];
		const style = stateStyle(record.state, this.frame);
		lines.push(this.row(` ${this.theme.fg(style.color, `${style.glyph} ${record.state}`)}  ${sanitizeTerminalMetadata(record.originalTarget)}  turn ${record.turn + 1}`, width));
		lines.push(this.row(` ${this.theme.fg("dim", sanitizeTerminalMetadata(record.cwd))}`, width));
		if (this.transcriptError) lines.push(this.row(` ${this.theme.fg("warning", sanitizeTerminalMetadata(this.transcriptError))}`, width));

		const innerWidth = Math.max(1, width - 4);
		const transcriptLines: string[] = [];
		for (const component of this.transcriptComponents) {
			const rendered = component.render(innerWidth);
			if (rendered.length === 0) continue;
			if (transcriptLines.length > 0) transcriptLines.push("");
			transcriptLines.push(...rendered);
		}
		if (transcriptLines.length === 0) transcriptLines.push(this.theme.fg("dim", "Waiting for transcript…"));
		const bodyHeight = this.bodyHeight();
		const maxScroll = Math.max(0, transcriptLines.length - bodyHeight);
		this.transcriptScroll = Math.min(this.transcriptScroll, maxScroll);
		const start = Math.max(0, transcriptLines.length - bodyHeight - this.transcriptScroll);
		const end = Math.min(transcriptLines.length, start + bodyHeight);
		for (const line of transcriptLines.slice(start, end)) lines.push(this.row(` ${line}`, width));
		lines.push(this.row("", width));
		lines.push(this.row(` ${this.theme.fg("dim", `↑/↓ scroll  PgUp/PgDn  Esc agents  ${start + 1}-${end}/${transcriptLines.length}  live`)}`, width));
		lines.push(this.footer(width));
		return lines;
	}

	private bodyHeight(): number {
		return Math.max(4, Math.floor(this.tui.terminal.rows * 0.8) - 6);
	}

	private header(text: string, width: number): string {
		const innerWidth = width - 2;
		const title = truncateToWidth(text, innerWidth, "");
		const padding = Math.max(0, innerWidth - visibleWidth(title));
		const left = Math.floor(padding / 2);
		return this.theme.fg("border", `╭${"─".repeat(left)}`) + this.theme.fg("accent", title) + this.theme.fg("border", `${"─".repeat(padding - left)}╮`);
	}

	private row(content: string, width: number): string {
		const innerWidth = width - 2;
		const text = truncateToWidth(content, innerWidth, "");
		return this.theme.fg("border", "│") + text + " ".repeat(Math.max(0, innerWidth - visibleWidth(text))) + this.theme.fg("border", "│");
	}

	private footer(width: number): string {
		return this.theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
	}
}

export function registerAgentsCommand(pi: ExtensionAPI, options: AgentsCommandOptions): void {
	pi.registerCommand("agents", {
		description: "Browse child threads and inspect live transcripts",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/agents requires interactive mode.", "warning");
				return;
			}
			const parentSessionId = options.currentSessionId?.(ctx) ?? ctx.sessionManager.getSessionId();
			if (!parentSessionId) {
				ctx.ui.notify("/agents requires a persisted parent session.", "warning");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new AgentsOverlay(tui, theme, () => done(undefined), {
				registry: options.registry,
				parentSessionId,
				trustedSessionRoots: options.trustedSessionRoots,
			}), {
				overlay: true,
				overlayOptions: { width: "92%", minWidth: 60, maxHeight: "88%", anchor: "center" },
			});
		},
	});
}
