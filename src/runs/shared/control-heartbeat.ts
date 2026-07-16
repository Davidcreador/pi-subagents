import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";

export const CONTROL_HEARTBEAT_MAX_AGE_MS = 15_000;
const CONTROL_HEARTBEAT_FUTURE_TOLERANCE_MS = 1_000;

interface ControlHeartbeat {
	version: 1;
	token: string;
	pid: number;
	updatedAt: number;
}

export function controlHeartbeatPath(controlDir: string): string {
	return path.join(controlDir, "heartbeat.json");
}

export function writeControlHeartbeat(controlDir: string, token: string, pid = process.pid, now = Date.now()): void {
	if (!token || !Number.isInteger(pid)) return;
	fs.mkdirSync(controlDir, { recursive: true });
	writeAtomicJson(controlHeartbeatPath(controlDir), { version: 1, token, pid, updatedAt: now } satisfies ControlHeartbeat);
}

export function hasFreshControlHeartbeat(controlDir: string, token: string | undefined, pid: number | undefined, now = Date.now()): boolean {
	if (!token || !Number.isInteger(pid)) return false;
	try {
		const heartbeatPath = controlHeartbeatPath(controlDir);
		const stat = fs.lstatSync(heartbeatPath);
		if (!stat.isFile() || stat.isSymbolicLink()) return false;
		const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, "utf-8")) as Partial<ControlHeartbeat>;
		return heartbeat.version === 1
			&& heartbeat.token === token
			&& heartbeat.pid === pid
			&& typeof heartbeat.updatedAt === "number"
			&& heartbeat.updatedAt <= now + CONTROL_HEARTBEAT_FUTURE_TOLERANCE_MS
			&& now - heartbeat.updatedAt <= CONTROL_HEARTBEAT_MAX_AGE_MS;
	} catch {
		return false;
	}
}
