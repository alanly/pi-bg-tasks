/**
 * Process start, stream capture, and exit handling. All logic responds
 * to events: 'exit', 'data', and wait promises. Only the per-task
 * timeouts and the SIGTERM -> SIGKILL escalation use timers.
 *
 * Processes run in their own process group (detached: true). Signals go
 * to the whole group with process.kill(-pid, signal), so a kill stops
 * the full process tree.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { BgTask } from "./types.ts";
import { TaskRegistry } from "./registry.ts";
import type { StatusLine } from "./statusline.ts";
import type { AlertDelivery } from "./alerts.ts";
import { TailBuffer } from "./ringbuf.ts";

/** Time between SIGTERM and SIGKILL in the kill sequence. */
export const KILL_GRACE_MS = 2000;

export interface StartOptions {
	command: string;
	cwd?: string;
	name?: string;
	/** Kill after this long. 0 or omitted: no timeout. */
	timeoutMs?: number;
	/** Tee the full stdout+stderr to this file (append mode). */
	logFile?: string;
}

export interface ProcessManagerDeps {
	registry: TaskRegistry;
	statusline: StatusLine;
	alerts: AlertDelivery;
}

export class ProcessManager {
	private shuttingDown = false;

	constructor(private deps: ProcessManagerDeps) {}

	/** Spawn a command as a new background task. Returns before the process ends. */
	start(opts: StartOptions): BgTask {
		if (this.shuttingDown) throw new Error("shutdown in progress");
		const registry = this.deps.registry;
		const id = registry.nextId();
		const cwd = opts.cwd ?? registry.getContext()?.cwd ?? process.cwd();
		let resolveExit!: () => void;
		const exitPromise = new Promise<void>((resolve) => {
			resolveExit = resolve;
		});
		const task: BgTask = {
			id,
			name: opts.name,
			command: opts.command,
			cwd,
			startedAt: Date.now(),
			status: "running",
			stdout: new TailBuffer(),
			stderr: new TailBuffer(),
			exitPromise,
			activeWaiters: 0,
			delivered: false,
		};
		const proc = spawn("/bin/bash", ["-lc", opts.command], {
			cwd,
			env: process.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		task.proc = proc;

		if (opts.logFile) {
			// Append mode: two tasks can share one log file without clobbering.
			task.logFile = opts.logFile;
			task.logStream = createWriteStream(opts.logFile, { flags: "a" });
		}

		proc.stdout?.on("data", (chunk: Buffer) => {
			task.stdout.append(chunk);
			task.logStream?.write(chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			task.stderr.append(chunk);
			task.logStream?.write(chunk);
		});

		proc.on("error", (err: NodeJS.ErrnoException) => {
			// Spawn failure: 'exit' may never fire.
			task.spawnError = err.message;
			this.handleExit(task, null, undefined, resolveExit);
		});
		proc.on("exit", (code, signal) => {
			this.handleExit(task, code, signal, resolveExit);
		});

		if (opts.timeoutMs && opts.timeoutMs > 0) {
			task.timeoutTimer = setTimeout(() => {
				task.timedOut = true;
				this.killTask(task, "timeout");
			}, opts.timeoutMs);
		}

		registry.add(task);
		this.deps.statusline.refresh();
		return task;
	}

	/** Finalize a task: exit fields, timers, streams, status line, alert. */
	private handleExit(task: BgTask, code: number | null, signal: string | undefined, resolveExit: () => void): void {
		if (task.status === "exited") return; // idempotence guard
		task.status = "exited";
		task.exitedAt = Date.now();
		task.exitCode = code;
		task.signal = signal;
		if (task.timeoutTimer) {
			clearTimeout(task.timeoutTimer);
			task.timeoutTimer = undefined;
		}
		if (task.killTimer) {
			clearTimeout(task.killTimer);
			task.killTimer = undefined;
		}
		task.logStream?.end();
		task.logStream = undefined;
		task.proc = undefined;
		this.deps.statusline.refresh();
		resolveExit();
		// R4: alert when no waiter is active. A waiter delivers the result.
		if (!this.shuttingDown && task.activeWaiters === 0) {
			this.deps.alerts.deliver(task);
		}
	}

	/** Send a signal to the whole process group. Returns false when the group is gone (ESRCH). */
	private killGroup(task: BgTask, proc: ChildProcess, sig: NodeJS.Signals): boolean {
		if (proc.pid === undefined) return false;
		try {
			process.kill(-proc.pid, sig);
			return true;
		} catch {
			// ESRCH: the group already ended.
			return false;
		}
	}

	/**
	 * Kill sequence for a running task: SIGTERM to the group, then
	 * SIGKILL after the grace period if the group still runs. The kill
	 * timer is cleared at a natural exit.
	 */
	private killTask(task: BgTask, reason: "timeout" | "stop", sig: NodeJS.Signals = "SIGTERM"): void {
		const proc = task.proc;
		if (!proc || task.status !== "running") return;
		this.killGroup(task, proc, sig);
		if (task.killTimer) clearTimeout(task.killTimer);
		task.killTimer = setTimeout(() => {
			if (task.proc && task.status === "running") this.killGroup(task, proc, "SIGKILL");
			task.killTimer = undefined;
		}, KILL_GRACE_MS);
		task.killTimer.unref?.();
	}

	/** bg_stop: stop a task. Returns false when the task already exited. */
	stop(task: BgTask, signalName: string = "SIGTERM"): boolean {
		// A signal to a dead process group throws an ESRCH error: no-op instead.
		if (task.status === "exited") return false;
		this.killTask(task, "stop", signalName as NodeJS.Signals);
		return true;
	}

	/**
	 * session_shutdown handler. Idempotent. Sends SIGTERM to all task
	 * groups, then SIGKILL after the grace period. Clears timers, ends
	 * log streams, and suppresses alerts (the session is going away).
	 */
	shutdownAll(): void {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		const running: BgTask[] = [];
		for (const task of this.deps.registry.all()) {
			if (task.timeoutTimer) {
				clearTimeout(task.timeoutTimer);
				task.timeoutTimer = undefined;
			}
			if (task.status === "running" && task.proc) {
				this.killGroup(task, task.proc, "SIGTERM");
				running.push(task);
			}
			task.logStream?.end();
			task.logStream = undefined;
		}
		const timer = setTimeout(() => {
			for (const task of running) {
				if (task.proc && task.status === "running") {
					this.killGroup(task, task.proc, "SIGKILL");
				}
			}
		}, KILL_GRACE_MS);
		timer.unref?.();
		this.deps.statusline.refresh();
	}
}
