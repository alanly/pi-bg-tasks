/**
 * Core types for pi-bg-tasks.
 */

import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TailBuffer } from "./ringbuf.ts";

/** Custom message type for completion alerts. */
export const CT_BG_COMPLETE = "bg-task-complete";

export type TaskStatus = "running" | "exited";

export interface BgTask {
	/** "bg-1", "bg-2", ... (per-session counter) */
	id: string;
	/** Optional label from the model. */
	name?: string;
	command: string;
	cwd: string;
	/** Date.now() at spawn. */
	startedAt: number;
	/** Date.now() at exit. */
	exitedAt?: number;
	status: TaskStatus;
	/** null = the process was killed by a signal. */
	exitCode?: number | null;
	/** Signal name that killed the process, when any. */
	signal?: string;
	/** True when the task was killed because its timeout expired. */
	timedOut?: boolean;
	stdout: TailBuffer;
	stderr: TailBuffer;
	/** Not present after exit. */
	proc?: ChildProcess;
	/** Created at spawn; the exit handler resolves it. */
	exitPromise: Promise<void>;
	/** More than 0 while a bg_wait call blocks on this task. */
	activeWaiters: number;
	/** The alert was already sent. */
	delivered: boolean;
	/** Path given to bg_run; full output was teed here. */
	logFile?: string;
	logStream?: WriteStream;
	/** Timer for the task timeout (timeoutMs). */
	timeoutTimer?: NodeJS.Timeout;
	/** Timer for the SIGTERM -> SIGKILL escalation. */
	killTimer?: NodeJS.Timeout;
	/** Set when the process failed to spawn. */
	spawnError?: string;
	/** Snapshot of the captured context (refreshed at session_start and in tool execute). */
}

export interface TaskSummary {
	id: string;
	name?: string;
	command: string;
	status: TaskStatus;
	exitCode?: number | null;
	signal?: string;
	timedOut?: boolean;
	/** Runtime while running; total duration once exited. */
	runningMs: number;
	/** True when the stdout or stderr tail buffer dropped data. */
	truncated: boolean;
	logFile?: string;
}

export interface RegistryCounts {
	running: number;
	done: number;
	failed: number;
}

export interface RegistrySnapshot {
	tasks: TaskSummary[];
	counts: RegistryCounts;
}

export type AnyExtensionContext = ExtensionContext;
