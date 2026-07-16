import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ASYNC_DIR, RESULTS_DIR, TEMP_ROOT_DIR, type AsyncStatus, type Details, type SubagentState } from "../shared/types.ts";
import { activeChildControllers } from "../runs/foreground/active-child-controllers.ts";
import { requestAsyncSteer } from "../runs/background/control-channel.ts";
import { reconcileAsyncRun } from "../runs/background/stale-run-reconciler.ts";
import { ChildThreadRegistry, hasValidSessionOwnership, type ChildThreadRecord, type ChildThreadState, type ContinuationClaim } from "../runs/shared/child-thread-registry.ts";
import { parseChildTarget } from "../runs/shared/child-identity.ts";
import { hasFreshControlHeartbeat } from "../runs/shared/control-heartbeat.ts";
import { nestedResultsPath, resolveInheritedNestedRouteFromEnv } from "../runs/shared/nested-events.ts";
import { readStatus } from "../shared/utils.ts";

export interface SendMessageParamsLike { target: string; message: string }

export interface ContinueStoredChildInput {
	record: ChildThreadRecord;
	message: string;
	ctx: ExtensionContext;
	nextRunId: string;
}

export interface SendMessageDeps {
	registry: ChildThreadRegistry;
	state: SubagentState;
	continueStoredChild: (input: ContinueStoredChildInput) => Promise<AgentToolResult<Details>>;
	trustedSessionRoots?: () => string[];
}

function result(text: string, isError = false, details: Partial<Details> = {}): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}), details: { mode: "management", results: [], ...details } };
}

function statusState(state: string): ChildThreadState {
	if (state === "complete" || state === "completed") return "complete";
	if (state === "failed" || state === "paused" || state === "queued" || state === "running") return state;
	if (state === "pending") return "queued";
	return "failed";
}

interface AsyncStepResolution {
	status: AsyncStatus;
	step: NonNullable<AsyncStatus["steps"]>[number];
	runtimeIndex: number;
}

function resolveStatusStep(status: AsyncStatus, runId: string, canonicalIndex: number): AsyncStepResolution | undefined {
	const expectedTarget = `${runId}:${canonicalIndex}`;
	const matchedIndex = status.steps?.findIndex((step) => step.childTarget === expectedTarget) ?? -1;
	const runtimeIndex = matchedIndex >= 0 ? matchedIndex : canonicalIndex;
	const step = status.steps?.[runtimeIndex];
	if (!step || (matchedIndex < 0 && step.childTarget !== undefined && step.childTarget !== expectedTarget)) return undefined;
	return { status, step, runtimeIndex };
}

function readRecordAsyncStep(record: ChildThreadRecord): AsyncStepResolution | undefined {
	if (!record.asyncDir || !fs.existsSync(record.asyncDir)) return undefined;
	const status = reconcileAsyncRun(record.asyncDir).status;
	if (!status || status.runId !== record.latestRunId) return undefined;
	return resolveStatusStep(status, record.latestRunId, record.latestIndex);
}

function refreshRecord(registry: ChildThreadRegistry, record: ChildThreadRecord): ChildThreadRecord {
	const resolved = readRecordAsyncStep(record);
	if (!resolved) return record;
	const { status, step } = resolved;
	const overallState = statusState(status.state);
	const stepState = statusState(step.status);
	const state = overallState === "complete" || overallState === "failed" || overallState === "paused" ? overallState : stepState;
	return registry.updateIfLatest(record.parentSessionId, record.originalTarget, {
		latestRunId: record.latestRunId,
		latestIndex: record.latestIndex,
	}, {
		state,
		cwd: step.cwd ?? record.cwd,
		sessionFile: step.sessionFile ?? record.sessionFile,
		transcriptPath: step.transcriptPath ?? record.transcriptPath,
		...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
	}) ?? registry.resolve(record.originalTarget, record.parentSessionId);
}

function lazyImportExact(target: string, currentParentSessionId: string, deps: SendMessageDeps): ChildThreadRecord | undefined {
	const parsed = parseChildTarget(target);
	if (!parsed) return undefined;
	const asyncDir = path.join(ASYNC_DIR, parsed.runId);
	const status = readStatus(asyncDir);
	if (status?.runId === parsed.runId) {
		const resolved = resolveStatusStep(status, parsed.runId, parsed.flatIndex);
		if (!resolved) return undefined;
		const { step } = resolved;
		return deps.registry.register({
			originalTarget: target,
			parentSessionId: status.sessionId ?? currentParentSessionId,
			runId: parsed.runId,
			index: parsed.flatIndex,
			state: step.status === "pending" ? "queued" : step.status === "running" ? "running" : step.status === "paused" ? "paused" : step.status === "complete" || step.status === "completed" ? "complete" : "failed",
			cwd: step.cwd ?? status.cwd ?? deps.state.baseCwd,
			agent: step.agent,
			sessionFile: step.sessionFile,
			transcriptPath: step.transcriptPath,
			asyncDir,
			startedAt: step.startedAt ?? status.startedAt,
			endedAt: step.endedAt,
		});
	}
	const foreground = deps.state.foregroundRuns?.get(parsed.runId);
	const child = foreground?.children.find((candidate) => candidate.childTarget === target) ?? foreground?.children[parsed.flatIndex];
	if (!foreground || !child || !child.sessionFile) return undefined;
	return deps.registry.register({ originalTarget: target, parentSessionId: currentParentSessionId, runId: parsed.runId, index: parsed.flatIndex, state: child.status === "completed" ? "complete" : child.status, cwd: child.cwd ?? foreground.cwd, agent: child.agent, sessionFile: child.sessionFile, transcriptPath: child.transcriptPath, endedAt: child.updatedAt });
}

function isContained(realCandidate: string, realRoot: string): boolean {
	return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`);
}

export function validateChildSessionFile(record: ChildThreadRecord, trustedRoots: string[], options: { allowActiveRuntimeRoot?: boolean } = {}): string {
	const sessionFile = record.sessionFile;
	if (!sessionFile) throw new Error(`Child '${record.originalTarget}' does not have a persisted session file; refusing to start fresh context.`);
	if (!path.isAbsolute(sessionFile) || path.extname(sessionFile) !== ".jsonl") throw new Error(`Child '${record.originalTarget}' has an unsafe session file: ${sessionFile}`);
	let realSessionFile: string;
	try {
		realSessionFile = fs.realpathSync(sessionFile);
		if (!fs.statSync(realSessionFile).isFile()) throw new Error("not a file");
	} catch {
		throw new Error(`Child '${record.originalTarget}' session file does not exist or is not a regular file: ${sessionFile}`);
	}
	const realRoots = trustedRoots.flatMap((root) => {
		try { return [fs.realpathSync(root)]; } catch { return []; }
	});
	const runtimeRootTrusted = realRoots.some((root) => isContained(realSessionFile, root));
	let persistedRootTrusted = false;
	if (record.trustedSessionRoot) {
		try { persistedRootTrusted = isContained(realSessionFile, fs.realpathSync(record.trustedSessionRoot)); } catch { persistedRootTrusted = false; }
	}
	if (!runtimeRootTrusted && !persistedRootTrusted) throw new Error(`Child '${record.originalTarget}' session file is outside trusted session roots: ${sessionFile}`);
	const hasOwnership = hasValidSessionOwnership(record, realSessionFile);
	if (!runtimeRootTrusted && !hasOwnership) throw new Error(`Child '${record.originalTarget}' persisted session root does not have durable ownership evidence.`);
	if (record.asyncDir && fs.existsSync(record.asyncDir)) {
		const status = readStatus(record.asyncDir);
		const statusFile = status?.runId === record.latestRunId ? resolveStatusStep(status, record.latestRunId, record.latestIndex)?.step.sessionFile : undefined;
		if (!statusFile) throw new Error(`Child '${record.originalTarget}' session file is not associated with its async run metadata.`);
		let realStatusFile: string;
		try { realStatusFile = fs.realpathSync(statusFile); } catch { throw new Error(`Child '${record.originalTarget}' async run session metadata is invalid.`); }
		if (realStatusFile !== realSessionFile) throw new Error(`Child '${record.originalTarget}' session file does not match its async run metadata.`);
	} else if (!hasOwnership && !(options.allowActiveRuntimeRoot && runtimeRootTrusted && (record.state === "queued" || record.state === "running"))) {
		throw new Error(`Child '${record.originalTarget}' session file does not have durable ownership evidence.`);
	}
	return realSessionFile;
}

interface PlannedContinuationEvidence {
	state: ChildThreadState;
	cwd?: string;
	sessionFile?: string;
	asyncDir: string;
}

function plannedContinuationPaths(nextRunId: string): { asyncDir: string; resultPath: string } {
	const nestedRoute = resolveInheritedNestedRouteFromEnv();
	return nestedRoute
		? {
			asyncDir: path.join(TEMP_ROOT_DIR, "nested-subagent-runs", nestedRoute.rootRunId, nextRunId),
			resultPath: nestedResultsPath(nestedRoute.rootRunId, nextRunId),
		}
		: { asyncDir: path.join(ASYNC_DIR, nextRunId), resultPath: path.join(RESULTS_DIR, `${nextRunId}.json`) };
}

function readPlannedContinuationEvidence(claim: ContinuationClaim): PlannedContinuationEvidence | undefined {
	const { nextRunId } = claim;
	const asyncDir = claim.asyncDir ?? path.join(ASYNC_DIR, nextRunId);
	const resultPath = claim.resultPath ?? path.join(RESULTS_DIR, `${nextRunId}.json`);
	const resolvedAsyncDir = path.resolve(asyncDir);
	const resolvedResultPath = path.resolve(resultPath);
	const topLevelAsyncDir = path.resolve(ASYNC_DIR, nextRunId);
	const nestedAsyncRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs");
	if ((resolvedAsyncDir !== topLevelAsyncDir && !isContained(resolvedAsyncDir, nestedAsyncRoot)) || path.basename(resolvedAsyncDir) !== nextRunId) {
		throw new Error(`Planned continuation '${nextRunId}' has unsafe async metadata.`);
	}
	if (!isContained(resolvedResultPath, path.resolve(RESULTS_DIR)) || path.basename(resolvedResultPath) !== `${nextRunId}.json`) {
		throw new Error(`Planned continuation '${nextRunId}' has unsafe result metadata.`);
	}
	const status = fs.existsSync(asyncDir) ? readStatus(asyncDir) : null;
	if (status && status.runId !== nextRunId) throw new Error(`Planned continuation '${nextRunId}' has mismatched async status metadata.`);
	let resultData: { id?: unknown; runId?: unknown; state?: unknown; success?: unknown; cwd?: unknown; sessionFile?: unknown; results?: unknown } | undefined;
	if (fs.existsSync(resultPath)) {
		const parsed = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Planned continuation '${nextRunId}' has invalid result metadata.`);
		resultData = parsed as typeof resultData;
		const resultId = typeof resultData?.runId === "string" ? resultData.runId : resultData?.id;
		if (resultId !== nextRunId) throw new Error(`Planned continuation '${nextRunId}' has mismatched result metadata.`);
	}
	if (!status && !resultData) return undefined;
	const resultStep = Array.isArray(resultData?.results) && resultData.results[0] && typeof resultData.results[0] === "object"
		? resultData.results[0] as { sessionFile?: unknown; cwd?: unknown }
		: undefined;
	const step = status?.steps?.[0];
	const rawState = step?.status ?? status?.state ?? resultData?.state;
	const state = rawState === "running" ? "running"
		: rawState === "queued" || rawState === "pending" ? "queued"
			: rawState === "paused" ? "paused"
				: rawState === "complete" || rawState === "completed" ? "complete"
					: rawState === "failed" ? "failed"
						: resultData?.success === true ? "complete" : "failed";
	const cwd = step?.cwd ?? status?.cwd ?? (typeof resultStep?.cwd === "string" ? resultStep.cwd : undefined) ?? (typeof resultData?.cwd === "string" ? resultData.cwd : undefined);
	const sessionFile = step?.sessionFile ?? status?.sessionFile ?? (typeof resultStep?.sessionFile === "string" ? resultStep.sessionFile : undefined) ?? (typeof resultData?.sessionFile === "string" ? resultData.sessionFile : undefined);
	return { state, asyncDir, ...(cwd ? { cwd } : {}), ...(sessionFile ? { sessionFile } : {}) };
}

function reconcilePlannedContinuation(registry: ChildThreadRegistry, record: ChildThreadRecord): ChildThreadRecord {
	const claim = record.continuationClaim;
	if (!claim) return record;
	const { nextRunId } = claim;
	const evidence = readPlannedContinuationEvidence(claim);
	if (!evidence) return record;
	if (evidence.cwd && path.resolve(evidence.cwd) !== path.resolve(record.cwd)) {
		throw new Error(`Planned continuation '${nextRunId}' has mismatched child cwd metadata.`);
	}
	if (evidence.sessionFile && record.sessionFile) {
		let evidenceSessionFile: string;
		let recordSessionFile: string;
		try {
			evidenceSessionFile = fs.realpathSync(evidence.sessionFile);
			recordSessionFile = fs.realpathSync(record.sessionFile);
		} catch {
			throw new Error(`Planned continuation '${nextRunId}' has invalid session metadata.`);
		}
		if (evidenceSessionFile !== recordSessionFile) throw new Error(`Planned continuation '${nextRunId}' points to a different child session.`);
	}
	return registry.reconcileContinuation(record.parentSessionId, record.originalTarget, nextRunId, {
		latestIndex: 0,
		state: evidence.state,
		asyncDir: evidence.asyncDir,
		cwd: record.cwd,
		sessionFile: record.sessionFile,
	}) ?? registry.resolve(record.originalTarget, record.parentSessionId);
}

export async function sendMessageToChild(
	params: SendMessageParamsLike,
	ctx: ExtensionContext,
	deps: SendMessageDeps,
): Promise<AgentToolResult<Details>> {
	const target = params.target.trim();
	const message = params.message.trim();
	if (!target) return result("send_message target must not be empty.", true);
	if (!message) return result("send_message message must not be empty.", true);
	const parentSessionId = ctx.sessionManager.getSessionId() ?? deps.state.currentSessionId;
	if (!parentSessionId) return result("send_message cannot resolve aliases because the current parent session has no session id.", true);
	let record: ChildThreadRecord;
	try {
		let resolved: ChildThreadRecord;
		try {
			resolved = deps.registry.resolve(target, parentSessionId);
		} catch (error) {
			const imported = lazyImportExact(target, parentSessionId, deps);
			if (!imported) throw error;
			resolved = imported;
		}
		record = refreshRecord(deps.registry, reconcilePlannedContinuation(deps.registry, resolved));
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}
	const latestTarget = `${record.latestRunId}:${record.latestIndex}`;
	if (activeChildControllers.get(latestTarget)) {
		try {
			const queued = activeChildControllers.send(latestTarget, message);
			return result(`Message queued for active foreground child ${record.originalTarget}${record.handle ? ` (${record.handle})` : ""}.\nRequest: ${queued.request.id}`);
		} catch (error) {
			return result(`Failed to steer foreground child ${record.originalTarget}: ${error instanceof Error ? error.message : String(error)}`, true);
		}
	}
	if (record.state === "detached") return result(`Child '${record.originalTarget}' is detached and cannot be messaged safely.`, true);
	if ((record.state === "running" || record.state === "queued") && record.asyncDir) {
		try {
			const resolved = readRecordAsyncStep(record);
			if (!resolved || !hasFreshControlHeartbeat(record.asyncDir, resolved.status.controlToken, resolved.status.pid) || (resolved.step.status !== "running" && resolved.step.status !== "pending") || (resolved.status.state !== "running" && resolved.status.state !== "queued")) {
				return result(`Child '${record.originalTarget}' has stale async metadata and cannot be steered safely.`, true);
			}
			requestAsyncSteer(record.asyncDir, { message, targetIndex: resolved.runtimeIndex, source: "send_message" });
			return result(`Message queued for async child ${record.originalTarget}${record.handle ? ` (${record.handle})` : ""} at ${latestTarget}.`);
		} catch (error) {
			return result(`Failed to steer async child ${record.originalTarget}: ${error instanceof Error ? error.message : String(error)}`, true);
		}
	}
	if (record.state === "running" || record.state === "queued") {
		return result(`Child '${record.originalTarget}' is a queued foreground child with no active marker; wait until it starts or settles.`, true);
	}
	try {
		validateChildSessionFile(record, deps.trustedSessionRoots?.() ?? []);
		if (!fs.existsSync(record.cwd) || !fs.statSync(record.cwd).isDirectory()) throw new Error(`Child '${record.originalTarget}' cwd no longer exists: ${record.cwd}`);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}
	let claim;
	const nextRunId = randomUUID();
	const plannedPaths = plannedContinuationPaths(nextRunId);
	try {
		claim = deps.registry.claimContinuation(record.parentSessionId, record.originalTarget, nextRunId, plannedPaths);
	} catch (error) {
		return result(error instanceof Error ? error.message : String(error), true);
	}
	if (!claim) return result(`Child '${record.originalTarget}' already has a continuation launch in progress.`, true);
	let continuation: AgentToolResult<Details>;
	try {
		continuation = await deps.continueStoredChild({ record: claim.record, message, ctx, nextRunId });
	} catch (error) {
		try {
			const reconciled = reconcilePlannedContinuation(deps.registry, claim.record);
			if (reconciled.latestRunId === nextRunId) return result(`Child '${record.originalTarget}' continuation launched as ${nextRunId}, but launch reporting failed: ${error instanceof Error ? error.message : String(error)}`, true);
			deps.registry.releaseContinuation(record.parentSessionId, record.originalTarget, claim.token);
		} catch { /* preserve launch error and leave uncertain claims blocked */ }
		return result(`Failed to continue child '${record.originalTarget}': ${error instanceof Error ? error.message : String(error)}`, true);
	}
	if (continuation.isError || continuation.details.asyncId !== nextRunId) {
		try {
			const reconciled = reconcilePlannedContinuation(deps.registry, claim.record);
			if (reconciled.latestRunId !== nextRunId) deps.registry.releaseContinuation(record.parentSessionId, record.originalTarget, claim.token);
		} catch { /* uncertain launches remain blocked for later reconciliation */ }
		if (!continuation.isError && continuation.details.asyncId !== nextRunId) return result(`Child '${record.originalTarget}' continuation returned unexpected run id '${continuation.details.asyncId ?? "missing"}'; reserved ${nextRunId}.`, true);
		return continuation;
	}
	let advanced: ChildThreadRecord;
	try {
		advanced = deps.registry.completeContinuation(record.parentSessionId, record.originalTarget, claim.token, {
			latestRunId: nextRunId,
			latestIndex: 0,
			state: "running",
			asyncDir: continuation.details.asyncDir ?? plannedPaths.asyncDir,
			cwd: record.cwd,
			sessionFile: record.sessionFile,
		});
	} catch (error) {
		return result(`Child '${record.originalTarget}' continuation launched, but its registry claim could not be advanced safely; the claim remains blocked: ${error instanceof Error ? error.message : String(error)}`, true);
	}
	const targetText = `Child thread: ${record.handle ? `${record.handle}=` : ""}${record.originalTarget} (turn ${advanced.turn}, latest ${advanced.latestRunId}:0)`;
	return { ...continuation, content: [...continuation.content, { type: "text", text: targetText }], details: { ...continuation.details, childTargets: [{ childTarget: record.originalTarget, ...(record.handle ? { handle: record.handle } : {}), agent: record.agent }] } };
}
