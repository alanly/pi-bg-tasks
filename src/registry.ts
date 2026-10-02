/**
 * Task registry: the in-memory task list, the captured extension context,
 * and count queries. The registry is passive data; process.ts drives the
 * changes and statusline.ts reads counts through it.
 */

import type { BgTask, RegistryCounts, RegistrySnapshot, TaskSummary } from "./types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Classification of an ended task. */
export type TaskClass = "done" | "failed";

/**
 * Pure helper: classify an exited task. Exit code 0 counts as "done".
 * A nonzero exit code, a kill signal, or a timeout counts as "failed".
 */
export function classifyExit(task: Pick<BgTask, "status" | "exitCode" | "signal" | "timedOut">): TaskClass {
	if (task.status !== "exited") throw new Error("classifyExit: task has not exited");
	if (task.timedOut) return "failed";
	if (task.exitCode === 0) return "done";
	return "failed";
}

export class TaskRegistry {
	private tasks = new Map<string, BgTask>();
	private counter = 0;
	private ctx?: ExtensionContext;

	/** Capture (or refresh) the extension context. */
	captureContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	getContext(): ExtensionContext | undefined {
		return this.ctx;
	}

	nextId(): string {
		return `bg-${++this.counter}`;
	}

	add(task: BgTask): void {
		this.tasks.set(task.id, task);
	}

	get(id: string): BgTask | undefined {
		return this.tasks.get(id);
	}

	all(): BgTask[] {
		return [...this.tasks.values()];
	}

	counts(): RegistryCounts {
		let running = 0;
		let done = 0;
		let failed = 0;
		for (const task of this.tasks.values()) {
			if (task.status === "running") running++;
			else if (classifyExit(task) === "done") done++;
			else failed++;
		}
		return { running, done, failed };
	}

	summary(task: BgTask): TaskSummary {
		return {
			id: task.id,
			name: task.name,
			command: task.command,
			status: task.status,
			exitCode: task.exitCode,
			signal: task.signal,
			timedOut: task.timedOut,
			runningMs: (task.exitedAt ?? Date.now()) - task.startedAt,
			truncated: task.stdout.truncated || task.stderr.truncated,
			logFile: task.logFile,
		};
	}

	snapshot(): RegistrySnapshot {
		return {
			tasks: this.all().map((t) => this.summary(t)),
			counts: this.counts(),
		};
	}
}
