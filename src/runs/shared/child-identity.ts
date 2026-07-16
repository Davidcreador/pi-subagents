import { isDynamicParallelStep, isParallelStep, type ChainStep, type DynamicParallelStep, type ParallelTaskItem, type SequentialStep } from "../../shared/settings.ts";

export const CHILD_HANDLE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const CHILD_TARGET_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*):(0|[1-9][0-9]*)$/;

export interface ChildIdentity {
	childTarget: string;
	handle?: string;
	runId: string;
	flatIndex: number;
	agent: string;
	cwd?: string;
}

export function childTarget(runId: string, flatIndex: number): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error(`Invalid child run id '${runId}'.`);
	if (!Number.isInteger(flatIndex) || flatIndex < 0) throw new Error("Child flat index must be a non-negative integer.");
	return `${runId}:${flatIndex}`;
}

export function parseChildTarget(value: string): { runId: string; flatIndex: number } | undefined {
	const match = CHILD_TARGET_PATTERN.exec(value.trim());
	if (!match) return undefined;
	return { runId: match[1]!, flatIndex: Number(match[2]) };
}

export function validateChildHandle(handle: string, label = "handle"): string {
	if (!CHILD_HANDLE_PATTERN.test(handle)) {
		throw new Error(`${label} must start with a letter and contain only letters, numbers, '_' or '-' (maximum 64 characters).`);
	}
	return handle;
}

export function expandCountHandle(handle: string | undefined, count: number, repeatIndex: number): string | undefined {
	if (!handle) return undefined;
	return count > 1 ? `${handle}-${repeatIndex + 1}` : handle;
}

export function validateUniqueHandles(handles: Array<{ handle?: string; label: string }>, existing: Iterable<string> = []): void {
	const seen = new Map<string, string>();
	for (const handle of existing) seen.set(handle, "an existing child thread");
	for (const entry of handles) {
		if (!entry.handle) continue;
		validateChildHandle(entry.handle, entry.label);
		const previous = seen.get(entry.handle);
		if (previous) throw new Error(`${entry.label} '${entry.handle}' collides with ${previous}. Handles must be unique within the parent session.`);
		seen.set(entry.handle, entry.label);
	}
}

export type HandleTask = { agent: string; handle?: string; cwd?: string };

export function collectStaticChildIdentities(input: {
	runId: string;
	handle?: string;
	agent?: string;
	tasks?: HandleTask[];
	chain?: ChainStep[];
	dynamicFanoutMaxItems?: number;
}): ChildIdentity[] {
	const identities: ChildIdentity[] = [];
	let flatIndex = 0;
	const add = (task: HandleTask) => {
		identities.push({
			childTarget: childTarget(input.runId, flatIndex),
			runId: input.runId,
			flatIndex,
			agent: task.agent,
			...(task.handle ? { handle: task.handle } : {}),
			...(task.cwd ? { cwd: task.cwd } : {}),
		});
		flatIndex++;
	};
	if (input.agent) {
		add({ agent: input.agent, handle: input.handle });
		return identities;
	}
	if (input.tasks) {
		for (const task of input.tasks) add(task);
		return identities;
	}
	for (const step of input.chain ?? []) {
		if (isParallelStep(step)) {
			for (const task of step.parallel) add(task);
		} else if (isDynamicParallelStep(step)) {
			flatIndex += step.expand.maxItems ?? input.dynamicFanoutMaxItems ?? 0;
		} else {
			add(step as SequentialStep & { handle?: string });
		}
	}
	return identities;
}

export function dynamicHandleTemplate(step: DynamicParallelStep): string | undefined {
	return (step.parallel as ParallelTaskItem & { handle?: string }).handle;
}
