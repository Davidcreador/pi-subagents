import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { parseChildTarget } from "../shared/child-identity.ts";
import { hasFreshControlHeartbeat, writeControlHeartbeat } from "../shared/control-heartbeat.ts";
import { writeSteerRequestToDir, type SteerRequest } from "../background/control-channel.ts";

const FOREGROUND_MARKER_HARD_STALE_MS = 24 * 60 * 60_000;

export interface ActiveChildController {
	target: string;
	inboxDir: string;
	pid: number;
	startedAt: number;
	token: string;
}

interface ActiveMarker {
	version: 1;
	target: string;
	pid: number;
	startedAt: number;
	token: string;
}

export function foregroundSteerInboxDir(runId: string, index: number): string {
	return path.join(TEMP_ROOT_DIR, "foreground-child-controls", runId, String(index));
}

function markerPath(inboxDir: string): string {
	return path.join(inboxDir, "active.json");
}

function processIsLive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch { return false; }
}

function controllerFromMarker(target: string): ActiveChildController | undefined {
	const parsed = parseChildTarget(target);
	if (!parsed) return undefined;
	const inboxDir = foregroundSteerInboxDir(parsed.runId, parsed.flatIndex);
	try {
		const marker = JSON.parse(fs.readFileSync(markerPath(inboxDir), "utf-8")) as Partial<ActiveMarker>;
		if (marker.version !== 1 || marker.target !== target || !Number.isInteger(marker.pid) || typeof marker.startedAt !== "number" || typeof marker.token !== "string") return undefined;
		if (Date.now() - marker.startedAt > FOREGROUND_MARKER_HARD_STALE_MS || !processIsLive(marker.pid!) || !hasFreshControlHeartbeat(inboxDir, marker.token, marker.pid)) return undefined;
		return { target, inboxDir, pid: marker.pid!, startedAt: marker.startedAt, token: marker.token };
	} catch {
		return undefined;
	}
}

class ActiveChildControllerMap {
	private readonly controllers = new Map<string, ActiveChildController>();

	register(target: string, inboxDir: string, pid = process.pid): () => void {
		fs.mkdirSync(inboxDir, { recursive: true });
		const controller = { target, inboxDir, pid, startedAt: Date.now(), token: randomUUID() };
		writeAtomicJson(markerPath(inboxDir), { version: 1, target, pid, startedAt: controller.startedAt, token: controller.token } satisfies ActiveMarker);
		writeControlHeartbeat(inboxDir, controller.token, pid);
		this.controllers.set(target, controller);
		return () => {
			if (this.controllers.get(target) === controller) this.controllers.delete(target);
			try {
				const marker = JSON.parse(fs.readFileSync(markerPath(inboxDir), "utf-8")) as Partial<ActiveMarker>;
				if (marker.target === target && marker.pid === pid && marker.token === controller.token) fs.rmSync(inboxDir, { recursive: true, force: true });
			} catch {
				// Marker may already have been cleaned after process exit.
			}
		};
	}

	get(target: string): ActiveChildController | undefined {
		const local = this.controllers.get(target);
		if (local && Date.now() - local.startedAt <= FOREGROUND_MARKER_HARD_STALE_MS && processIsLive(local.pid) && hasFreshControlHeartbeat(local.inboxDir, local.token, local.pid)) return local;
		return controllerFromMarker(target);
	}

	send(target: string, message: string): { request: SteerRequest; requestPath: string } {
		const controller = this.get(target);
		if (!controller) throw new Error(`Child '${target}' is not an active foreground child.`);
		const trimmed = message.trim();
		if (!trimmed) throw new Error("message must not be empty.");
		const request: SteerRequest = {
			type: "steer",
			id: randomUUID(),
			ts: Date.now(),
			message: trimmed,
			source: "send_message",
		};
		return { request, requestPath: writeSteerRequestToDir(controller.inboxDir, request) };
	}

	clear(): void {
		// Extension reload must not revoke markers owned by still-live child processes.
		this.controllers.clear();
	}
}

export const activeChildControllers = new ActiveChildControllerMap();
