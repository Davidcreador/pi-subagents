import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { parseChildTarget, validateChildHandle } from "./child-identity.ts";

export const CHILD_THREAD_REGISTRY_VERSION = 1;
const MAX_SETTLED_RECORDS = 1000;
const ACTIVE_STATES = new Set<ChildThreadState>(["queued", "running"]);
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_HARD_STALE_LOCK_MS = 2 * 60_000;
const DEFAULT_STALE_CLAIM_MS = 5 * 60_000;
const DEFAULT_HARD_STALE_CLAIM_MS = 30 * 60_000;
const LOCK_RETRY_MS = 10;

export type ChildThreadState = "queued" | "running" | "complete" | "failed" | "paused" | "detached";

export interface ContinuationClaim {
	token: string;
	pid: number;
	claimedAt: number;
	nextRunId: string;
	asyncDir?: string;
	resultPath?: string;
}

export interface ChildThreadRecord {
	originalTarget: string;
	handle?: string;
	parentSessionId: string;
	latestRunId: string;
	latestIndex: number;
	state: ChildThreadState;
	cwd: string;
	agent: string;
	sessionFile?: string;
	transcriptPath?: string;
	asyncDir?: string;
	trustedSessionRoot?: string;
	sessionOwnershipToken?: string;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	endedAt?: number;
	turn: number;
	continuationClaim?: ContinuationClaim;
}

interface RegistryFile {
	version: typeof CHILD_THREAD_REGISTRY_VERSION;
	sessions: Record<string, { records: Record<string, ChildThreadRecord> }>;
}

export interface RegisterChildThreadInput {
	originalTarget: string;
	handle?: string;
	parentSessionId: string;
	runId: string;
	index: number;
	state: ChildThreadState;
	cwd: string;
	agent: string;
	sessionFile?: string;
	transcriptPath?: string;
	asyncDir?: string;
	trustedSessionRoot?: string;
	turn?: number;
	startedAt?: number;
	endedAt?: number;
}

export interface ChildThreadRegistryOptions {
	filePath?: string;
	now?: () => number;
	lockTimeoutMs?: number;
	staleLockMs?: number;
	hardStaleLockMs?: number;
	staleClaimMs?: number;
	hardStaleClaimMs?: number;
}

export interface ClaimedContinuation {
	record: ChildThreadRecord;
	token: string;
}

export function childThreadRegistryPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "extensions", "subagent", "child-threads", `v${CHILD_THREAD_REGISTRY_VERSION}`, "registry.json");
}

function emptyRegistry(): RegistryFile {
	return { version: CHILD_THREAD_REGISTRY_VERSION, sessions: {} };
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown, parentSessionId: string, originalTarget: string): value is ChildThreadRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<ChildThreadRecord>;
	if (record.originalTarget !== originalTarget || record.parentSessionId !== parentSessionId || !parseChildTarget(originalTarget)) return false;
	if (record.handle !== undefined) {
		try { validateChildHandle(record.handle); } catch { return false; }
	}
	if (typeof record.latestRunId !== "string" || !parseChildTarget(`${record.latestRunId}:${record.latestIndex}`)) return false;
	if (!ACTIVE_STATES.has(record.state as ChildThreadState) && !["complete", "failed", "paused", "detached"].includes(record.state as string)) return false;
	if (typeof record.cwd !== "string" || !path.isAbsolute(record.cwd) || typeof record.agent !== "string" || !record.agent) return false;
	if (!isFiniteNumber(record.createdAt) || !isFiniteNumber(record.updatedAt) || !Number.isInteger(record.turn) || record.turn! < 0) return false;
	for (const key of ["sessionFile", "transcriptPath", "asyncDir", "trustedSessionRoot", "sessionOwnershipToken"] as const) if (record[key] !== undefined && typeof record[key] !== "string") return false;
	if (record.trustedSessionRoot !== undefined && !path.isAbsolute(record.trustedSessionRoot)) return false;
	for (const key of ["startedAt", "endedAt"] as const) if (record[key] !== undefined && !isFiniteNumber(record[key])) return false;
	if (record.continuationClaim !== undefined) {
		const claim = record.continuationClaim;
		if (!claim || typeof claim.token !== "string" || !Number.isInteger(claim.pid) || !isFiniteNumber(claim.claimedAt) || typeof claim.nextRunId !== "string" || !parseChildTarget(`${claim.nextRunId}:0`)) return false;
		for (const key of ["asyncDir", "resultPath"] as const) if (claim[key] !== undefined && (typeof claim[key] !== "string" || !path.isAbsolute(claim[key]))) return false;
	}
	return true;
}

function quarantineRegistry(filePath: string): void {
	try {
		fs.renameSync(filePath, `${filePath}.invalid-${Date.now()}-${randomUUID()}`);
	} catch {
		// Another process may already have replaced or quarantined it.
	}
}

function readRegistry(filePath: string, quarantine = false): RegistryFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
		if (quarantine) quarantineRegistry(filePath);
		return emptyRegistry();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		if (quarantine) quarantineRegistry(filePath);
		return emptyRegistry();
	}
	const source = parsed as Partial<RegistryFile>;
	if (source.version !== CHILD_THREAD_REGISTRY_VERSION || !source.sessions || typeof source.sessions !== "object" || Array.isArray(source.sessions)) {
		if (quarantine) quarantineRegistry(filePath);
		return emptyRegistry();
	}
	const registry = emptyRegistry();
	for (const [parentSessionId, sessionValue] of Object.entries(source.sessions)) {
		if (!parentSessionId || !sessionValue || typeof sessionValue !== "object" || Array.isArray(sessionValue)) continue;
		const recordsValue = (sessionValue as { records?: unknown }).records;
		if (!recordsValue || typeof recordsValue !== "object" || Array.isArray(recordsValue)) continue;
		const records: Record<string, ChildThreadRecord> = {};
		for (const [target, value] of Object.entries(recordsValue)) if (isRecord(value, parentSessionId, target)) records[target] = value;
		if (Object.keys(records).length) registry.sessions[parentSessionId] = { records };
	}
	return registry;
}

function trimRegistry(registry: RegistryFile): void {
	const settled = Object.values(registry.sessions)
		.flatMap((session) => Object.values(session.records))
		.filter((record) => !ACTIVE_STATES.has(record.state) && !record.continuationClaim)
		.sort((left, right) => left.updatedAt - right.updatedAt);
	const removeCount = Math.max(0, settled.length - MAX_SETTLED_RECORDS);
	for (const record of settled.slice(0, removeCount)) {
		delete registry.sessions[record.parentSessionId]?.records[record.originalTarget];
		if (Object.keys(registry.sessions[record.parentSessionId]?.records ?? {}).length === 0) delete registry.sessions[record.parentSessionId];
	}
}

function processDefinitelyGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

interface SessionOwnershipSidecar {
	version: 1;
	token: string;
	sessionFile: string;
	parentSessionId: string;
	originalTarget: string;
}

export function sessionOwnershipSidecarPath(sessionFile: string): string {
	return `${sessionFile}.pi-subagent-owner.json`;
}

function canonicalSessionPath(sessionFile: string): string {
	try { return fs.realpathSync(sessionFile); }
	catch { return path.resolve(sessionFile); }
}

function writeSessionOwnership(record: Pick<ChildThreadRecord, "sessionFile" | "sessionOwnershipToken" | "parentSessionId" | "originalTarget">): void {
	if (!record.sessionFile || !record.sessionOwnershipToken || !fs.existsSync(record.sessionFile)) return;
	const sidecarPath = sessionOwnershipSidecarPath(record.sessionFile);
	try {
		writeAtomicJson(sidecarPath, {
			version: 1,
			token: record.sessionOwnershipToken,
			sessionFile: canonicalSessionPath(record.sessionFile),
			parentSessionId: record.parentSessionId,
			originalTarget: record.originalTarget,
		} satisfies SessionOwnershipSidecar);
	} catch {
		// Registry updates remain usable when a custom session directory is read-only.
	}
}

export function hasValidSessionOwnership(record: ChildThreadRecord, realSessionFile: string): boolean {
	if (!record.sessionFile || !record.sessionOwnershipToken) return false;
	try {
		const sidecarPath = sessionOwnershipSidecarPath(record.sessionFile);
		const stat = fs.lstatSync(sidecarPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return false;
		const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf-8")) as Partial<SessionOwnershipSidecar>;
		return sidecar.version === 1
			&& sidecar.token === record.sessionOwnershipToken
			&& sidecar.sessionFile === realSessionFile
			&& sidecar.parentSessionId === record.parentSessionId
			&& sidecar.originalTarget === record.originalTarget;
	} catch {
		return false;
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class ChildThreadRegistry {
	readonly filePath: string;
	private readonly now: () => number;
	private readonly lockTimeoutMs: number;
	private readonly staleLockMs: number;
	private readonly hardStaleLockMs: number;
	private readonly staleClaimMs: number;
	private readonly hardStaleClaimMs: number;

	constructor(options: ChildThreadRegistryOptions = {}) {
		this.filePath = options.filePath ?? childThreadRegistryPath();
		this.now = options.now ?? Date.now;
		this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
		this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
		this.hardStaleLockMs = options.hardStaleLockMs ?? DEFAULT_HARD_STALE_LOCK_MS;
		this.staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
		this.hardStaleClaimMs = options.hardStaleClaimMs ?? DEFAULT_HARD_STALE_CLAIM_MS;
	}

	private withLock<T>(fn: () => T): T {
		const lockPath = `${this.filePath}.lock`;
		const deadline = Date.now() + this.lockTimeoutMs;
		fs.mkdirSync(lockPath, { recursive: true });
		const createdAt = Date.now();
		const contenderName = `${randomUUID()}.json`;
		const contenderPath = path.join(lockPath, contenderName);
		fs.writeFileSync(contenderPath, JSON.stringify({ pid: process.pid, createdAt, choosing: true, ticket: 0 }), { flag: "wx" });
		try {
			let maxTicket = 0;
			for (const name of fs.readdirSync(lockPath).filter((entry) => entry.endsWith(".json"))) {
				try {
					const contender = JSON.parse(fs.readFileSync(path.join(lockPath, name), "utf-8")) as { ticket?: unknown };
					if (Number.isInteger(contender.ticket) && (contender.ticket as number) > maxTicket) maxTicket = contender.ticket as number;
				} catch { /* incomplete contenders remain ordered by the choosing flag */ }
			}
			const ticket = maxTicket + 1;
			fs.writeFileSync(contenderPath, JSON.stringify({ pid: process.pid, createdAt, choosing: false, ticket }));
			while (true) {
				let blocked = false;
				for (const name of fs.readdirSync(lockPath).filter((entry) => entry.endsWith(".json"))) {
					if (name === contenderName) continue;
					const candidatePath = path.join(lockPath, name);
					try {
						const owner = JSON.parse(fs.readFileSync(candidatePath, "utf-8")) as { pid?: unknown; createdAt?: unknown; choosing?: unknown; ticket?: unknown };
						const age = isFiniteNumber(owner.createdAt) ? Date.now() - owner.createdAt : 0;
						const stale = age > this.hardStaleLockMs || (age > this.staleLockMs && Number.isInteger(owner.pid) && processDefinitelyGone(owner.pid as number));
						if (stale) {
							try { fs.unlinkSync(candidatePath); } catch { /* another process recovered it */ }
							continue;
						}
						if (owner.choosing === true || !Number.isInteger(owner.ticket) || (owner.ticket as number) < ticket || ((owner.ticket as number) === ticket && name < contenderName)) blocked = true;
					} catch {
						let stale = false;
						try { stale = Date.now() - fs.statSync(candidatePath).mtimeMs > this.staleLockMs; } catch { continue; }
						if (stale) try { fs.unlinkSync(candidatePath); } catch { /* another process recovered it */ }
						else blocked = true;
					}
				}
				if (!blocked) break;
				if (Date.now() >= deadline) throw new Error(`Timed out waiting for child-thread registry lock '${lockPath}'.`);
				sleepSync(LOCK_RETRY_MS);
			}
			return fn();
		} finally {
			try { fs.unlinkSync(contenderPath); } catch { /* stale recovery remains available */ }
		}
	}

	private mutate<T>(fn: (registry: RegistryFile) => T): T {
		return this.withLock(() => {
			const registry = readRegistry(this.filePath, true);
			const result = fn(registry);
			trimRegistry(registry);
			writeAtomicJson(this.filePath, registry);
			return result;
		});
	}

	register(input: RegisterChildThreadInput): ChildThreadRecord {
		return this.registerMany([input])[0]!;
	}

	registerMany(inputs: RegisterChildThreadInput[]): ChildThreadRecord[] {
		if (inputs.length === 0) return [];
		return this.mutate((registry) => {
			const targets = new Set<string>();
			const proposedHandles = new Map<string, string>();
			for (const input of inputs) {
				if (!parseChildTarget(input.originalTarget)) throw new Error(`Invalid canonical child target '${input.originalTarget}'.`);
				if (!path.isAbsolute(input.cwd)) throw new Error(`Child '${input.originalTarget}' cwd must be absolute.`);
				if (input.trustedSessionRoot !== undefined && !path.isAbsolute(input.trustedSessionRoot)) throw new Error(`Child '${input.originalTarget}' trusted session root must be absolute.`);
				if (targets.has(`${input.parentSessionId}\0${input.originalTarget}`)) throw new Error(`Duplicate child target '${input.originalTarget}' in one registration transaction.`);
				targets.add(`${input.parentSessionId}\0${input.originalTarget}`);
				if (input.handle) validateChildHandle(input.handle, `handle for child ${input.originalTarget}`);
			}
			for (const input of inputs) {
				const effectiveHandle = input.handle ?? registry.sessions[input.parentSessionId]?.records[input.originalTarget]?.handle;
				if (!effectiveHandle) continue;
				const key = `${input.parentSessionId}\0${effectiveHandle}`;
				if (proposedHandles.has(key)) throw new Error(`Handle '${effectiveHandle}' collides within the registration transaction.`);
				proposedHandles.set(key, input.originalTarget);
			}
			for (const [parentSessionId, session] of Object.entries(registry.sessions)) {
				for (const record of Object.values(session.records)) {
					if (!record.handle || targets.has(`${parentSessionId}\0${record.originalTarget}`)) continue;
					if (proposedHandles.has(`${parentSessionId}\0${record.handle}`)) throw new Error(`Handle '${record.handle}' collides with an existing child thread. Handles must be unique within the parent session.`);
				}
			}
			const now = this.now();
			return inputs.map((input) => {
				const session = registry.sessions[input.parentSessionId] ??= { records: {} };
				const existing = session.records[input.originalTarget];
				const ownershipToken = input.sessionFile
					? existing?.sessionFile === input.sessionFile && existing.sessionOwnershipToken ? existing.sessionOwnershipToken : randomUUID()
					: existing?.sessionOwnershipToken;
				const result: ChildThreadRecord = {
					originalTarget: input.originalTarget,
					parentSessionId: input.parentSessionId,
					latestRunId: input.runId,
					latestIndex: input.index,
					state: input.state,
					cwd: input.cwd,
					agent: input.agent,
					createdAt: existing?.createdAt ?? now,
					updatedAt: now,
					turn: input.turn ?? existing?.turn ?? 0,
					...(input.handle ?? existing?.handle ? { handle: input.handle ?? existing?.handle } : {}),
					...(input.sessionFile ?? existing?.sessionFile ? { sessionFile: input.sessionFile ?? existing?.sessionFile } : {}),
					...(input.transcriptPath ?? existing?.transcriptPath ? { transcriptPath: input.transcriptPath ?? existing?.transcriptPath } : {}),
					...(input.asyncDir ?? existing?.asyncDir ? { asyncDir: input.asyncDir ?? existing?.asyncDir } : {}),
					...(input.trustedSessionRoot ?? existing?.trustedSessionRoot ? { trustedSessionRoot: input.trustedSessionRoot ?? existing?.trustedSessionRoot } : {}),
					...(ownershipToken ? { sessionOwnershipToken: ownershipToken } : {}),
					...(input.startedAt ?? existing?.startedAt ? { startedAt: input.startedAt ?? existing?.startedAt } : {}),
					...(input.endedAt !== undefined ? { endedAt: input.endedAt } : existing?.endedAt !== undefined ? { endedAt: existing.endedAt } : {}),
					...(existing?.continuationClaim ? { continuationClaim: existing.continuationClaim } : {}),
				};
				writeSessionOwnership(result);
				session.records[input.originalTarget] = result;
				return result;
			});
		});
	}

	private applyUpdate(registry: RegistryFile, parentSessionId: string, originalTarget: string, patch: Partial<Omit<ChildThreadRecord, "originalTarget" | "parentSessionId" | "createdAt">>): ChildThreadRecord {
		const existing = registry.sessions[parentSessionId]?.records[originalTarget];
		if (!existing) throw new Error(`Unknown child thread '${originalTarget}'.`);
		if (patch.handle) {
			validateChildHandle(patch.handle, `handle for child ${originalTarget}`);
			const collision = Object.values(registry.sessions[parentSessionId]?.records ?? {}).find((record) => record.originalTarget !== originalTarget && record.handle === patch.handle);
			if (collision) throw new Error(`Handle '${patch.handle}' collides with an existing child thread. Handles must be unique within the parent session.`);
		}
		const sessionOwnershipToken = patch.sessionFile && patch.sessionFile !== existing.sessionFile
			? randomUUID()
			: patch.sessionOwnershipToken ?? existing.sessionOwnershipToken;
		const result = { ...existing, ...patch, ...(sessionOwnershipToken ? { sessionOwnershipToken } : {}), originalTarget, parentSessionId, createdAt: existing.createdAt, updatedAt: this.now() };
		writeSessionOwnership(result);
		registry.sessions[parentSessionId]!.records[originalTarget] = result;
		return result;
	}

	update(parentSessionId: string, originalTarget: string, patch: Partial<Omit<ChildThreadRecord, "originalTarget" | "parentSessionId" | "createdAt">>): ChildThreadRecord {
		return this.mutate((registry) => this.applyUpdate(registry, parentSessionId, originalTarget, patch));
	}

	updateIfLatest(parentSessionId: string, originalTarget: string, expected: { latestRunId: string; latestIndex: number }, patch: Partial<Omit<ChildThreadRecord, "originalTarget" | "parentSessionId" | "createdAt">>): ChildThreadRecord | undefined {
		return this.mutate((registry) => {
			const existing = registry.sessions[parentSessionId]?.records[originalTarget];
			if (!existing) throw new Error(`Unknown child thread '${originalTarget}'.`);
			if (existing.latestRunId !== expected.latestRunId || existing.latestIndex !== expected.latestIndex) return undefined;
			return this.applyUpdate(registry, parentSessionId, originalTarget, patch);
		});
	}

	updateIfLatestInStates(parentSessionId: string, originalTarget: string, expected: { latestRunId: string; latestIndex: number }, states: readonly ChildThreadState[], patch: Partial<Omit<ChildThreadRecord, "originalTarget" | "parentSessionId" | "createdAt">>): ChildThreadRecord | undefined {
		return this.mutate((registry) => {
			const existing = registry.sessions[parentSessionId]?.records[originalTarget];
			if (!existing) throw new Error(`Unknown child thread '${originalTarget}'.`);
			if (existing.latestRunId !== expected.latestRunId || existing.latestIndex !== expected.latestIndex || !states.includes(existing.state)) return undefined;
			return this.applyUpdate(registry, parentSessionId, originalTarget, patch);
		});
	}

	claimContinuation(parentSessionId: string, originalTarget: string, nextRunId: string, paths: { asyncDir: string; resultPath: string } | undefined = undefined): ClaimedContinuation | undefined {
		return this.mutate((registry) => {
			const record = registry.sessions[parentSessionId]?.records[originalTarget];
			if (!record) throw new Error(`Unknown child thread '${originalTarget}'.`);
			if (!parseChildTarget(`${nextRunId}:0`)) throw new Error(`Invalid planned continuation run id '${nextRunId}'.`);
			if (paths && (!path.isAbsolute(paths.asyncDir) || !path.isAbsolute(paths.resultPath))) throw new Error("Planned continuation paths must be absolute.");
			const existing = record.continuationClaim;
			const claimAge = existing ? this.now() - existing.claimedAt : 0;
			if (existing && !(claimAge > this.hardStaleClaimMs || (claimAge > this.staleClaimMs && processDefinitelyGone(existing.pid)))) return undefined;
			const token = randomUUID();
			record.continuationClaim = { token, pid: process.pid, claimedAt: this.now(), nextRunId, ...paths };
			record.updatedAt = this.now();
			return { record: { ...record }, token };
		});
	}

	releaseContinuation(parentSessionId: string, originalTarget: string, token: string): void {
		this.mutate((registry) => {
			const record = registry.sessions[parentSessionId]?.records[originalTarget];
			if (record?.continuationClaim?.token === token) {
				delete record.continuationClaim;
				record.updatedAt = this.now();
			}
		});
	}

	completeContinuation(parentSessionId: string, originalTarget: string, token: string, patch: Pick<ChildThreadRecord, "latestRunId" | "latestIndex" | "state"> & Partial<Pick<ChildThreadRecord, "asyncDir" | "sessionFile" | "cwd">>): ChildThreadRecord {
		return this.mutate((registry) => {
			const record = registry.sessions[parentSessionId]?.records[originalTarget];
			if (!record || record.continuationClaim?.token !== token) throw new Error(`Continuation claim for child '${originalTarget}' is no longer owned by this process.`);
			if (record.continuationClaim.nextRunId !== patch.latestRunId) throw new Error(`Continuation claim for child '${originalTarget}' reserved a different run id.`);
			const result: ChildThreadRecord = { ...record, ...patch, turn: record.turn + 1, endedAt: undefined, updatedAt: this.now() };
			delete result.continuationClaim;
			writeSessionOwnership(result);
			registry.sessions[parentSessionId]!.records[originalTarget] = result;
			return result;
		});
	}

	reconcileContinuation(parentSessionId: string, originalTarget: string, nextRunId: string, patch: Pick<ChildThreadRecord, "latestIndex" | "state"> & Partial<Pick<ChildThreadRecord, "asyncDir" | "sessionFile" | "cwd">>): ChildThreadRecord | undefined {
		return this.mutate((registry) => {
			const record = registry.sessions[parentSessionId]?.records[originalTarget];
			if (!record || record.continuationClaim?.nextRunId !== nextRunId) return undefined;
			const result: ChildThreadRecord = { ...record, ...patch, latestRunId: nextRunId, turn: record.turn + 1, endedAt: undefined, updatedAt: this.now() };
			delete result.continuationClaim;
			writeSessionOwnership(result);
			registry.sessions[parentSessionId]!.records[originalTarget] = result;
			return result;
		});
	}

	list(parentSessionId?: string): ChildThreadRecord[] {
		const registry = readRegistry(this.filePath);
		const records = parentSessionId
			? Object.values(registry.sessions[parentSessionId]?.records ?? {})
			: Object.values(registry.sessions).flatMap((session) => Object.values(session.records));
		return records.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	handles(parentSessionId: string): string[] {
		return this.list(parentSessionId).flatMap((record) => record.handle ? [record.handle] : []);
	}

	resolve(target: string, currentParentSessionId: string): ChildThreadRecord {
		const records = this.list();
		if (parseChildTarget(target)) {
			const exact = records.filter((record) => record.originalTarget === target || `${record.latestRunId}:${record.latestIndex}` === target);
			if (exact.length === 0) throw new Error(`Unknown child target '${target}'.`);
			if (exact.length > 1) throw new Error(`Ambiguous child target '${target}' matched multiple persisted threads.`);
			return exact[0]!;
		}
		const aliases = records.filter((record) => record.parentSessionId === currentParentSessionId && record.handle === target);
		if (aliases.length === 0) throw new Error(`Unknown child handle '${target}' in the current parent session.`);
		if (aliases.length > 1) throw new Error(`Ambiguous child handle '${target}' in the current parent session.`);
		return aliases[0]!;
	}
}
