import type { ChildProcess } from "node:child_process";

export interface BackgroundWorkSignal extends AbortSignal {
	backgroundWorkPromoted?: boolean;
	backgroundWorkSessionId?: string;
}

export function backgroundWorkSupervisorState(signal: AbortSignal | undefined, pending: boolean, requestId: string) {
	return { pending, requestId, sessionId: (signal as BackgroundWorkSignal | undefined)?.backgroundWorkSessionId };
}

export function isBackgroundWorkPromoted(signal: AbortSignal | undefined): boolean {
	return (signal as BackgroundWorkSignal | undefined)?.backgroundWorkPromoted === true;
}

export function isBackgroundWorkHardCancel(signal: AbortSignal | undefined): boolean {
	return (signal?.reason as { backgroundWorkHardCancel?: boolean } | undefined)?.backgroundWorkHardCancel === true;
}

export function shouldDetachForIntercomAbort(signal: AbortSignal | undefined, allowIntercomDetach: boolean, intercomStarted: boolean): boolean {
	return allowIntercomDetach && intercomStarted && !isBackgroundWorkHardCancel(signal) && !isBackgroundWorkPromoted(signal);
}

/** Foreground children own a Unix process group so promotion-time cancellation reaches descendants. */
export function foregroundSpawnDetached(platform = process.platform): boolean {
	return platform !== "win32";
}

/** Signal the Unix process group first, falling back to the direct child on unsupported platforms/races. */
export function signalForegroundProcessTree(
	child: Pick<ChildProcess, "pid" | "kill">,
	signal: NodeJS.Signals,
	platform = process.platform,
	killProcess: typeof process.kill = process.kill,
): boolean {
	if (platform !== "win32" && child.pid) {
		try {
			killProcess(-child.pid, signal);
			return true;
		} catch {
			// The group may already have exited; direct-child signaling retains prior behavior.
		}
	}
	try {
		return child.kill(signal);
	} catch {
		return false;
	}
}
