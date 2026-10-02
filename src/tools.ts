/**
 * The five bg_* tools. All tools share the registry in memory, so all
 * use executionMode "sequential" (bg_wait also changes activeWaiters).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BgTask, RegistrySnapshot } from "./types.ts";
import type { TaskRegistry } from "./registry.ts";
import type { ProcessManager } from "./process.ts";
import type { AlertDelivery } from "./alerts.ts";
import { exitDescription, formatDuration } from "./alerts.ts";

const BG_NAMESPACE = { name: "bg", description: "Background shell tasks" };
const DEFAULT_TAIL_BYTES = 8 * 1024;

function textContent(text: string): { type: "text"; text: string }[] {
	return [{ type: "text", text }];
}

function combinedTail(task: BgTask, maxBytes: number): string {
	return [task.stderr.text(maxBytes), task.stdout.text(maxBytes)]
		.filter((s) => s.length > 0)
		.join("\n");
}

/** One status line for a task. */
function taskLine(task: BgTask): string {
	const label = task.name ? `${task.name}` : task.command;
	const runtime = formatDuration((task.exitedAt ?? Date.now()) - task.startedAt);
	const tail = combinedTail(task, 240).replace(/\n+/g, " | ");
	const state =
		task.status === "running" ? `running ${runtime}` : `${exitDescription(task)} after ${runtime}`;
	const flag = task.stdout.truncated || task.stderr.truncated ? " [truncated]" : "";
	return `${task.id}: ${label} — ${state}${flag}\n  tail: ${tail}`;
}

function snapshotOf(registry: TaskRegistry): RegistrySnapshot {
	return registry.snapshot();
}

export interface RegisterToolsDeps {
	registry: TaskRegistry;
	processMgr: ProcessManager;
	alerts: AlertDelivery;
}

export function registerTools(pi: ExtensionAPI, deps: RegisterToolsDeps): void {
	const { registry, processMgr, alerts } = deps;

	// ---------- bg_run (R1) ----------
	pi.registerTool({
		name: "bg_run",
		label: "Run background task",
		namespace: BG_NAMESPACE,
		description:
			"Start a shell command as a background task. Returns immediately. " +
			"You will be notified with the result when it finishes. Use bg_wait to block. " +
			"Use bg_status and bg_output to inspect.",
		executionMode: "sequential",
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run via bash -c" }),
			cwd: Type.Optional(Type.String({ description: "Working directory (default: session cwd)" })),
			name: Type.Optional(Type.String({ description: "Short label for the task" })),
			timeoutMs: Type.Optional(Type.Number({ description: "Kill after this long; 0/omitted = no timeout" })),
			logFile: Type.Optional(
				Type.String({ description: "Tee full stdout+stderr to this file (tail buffer still kept)" }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			registry.captureContext(ctx);
			const task = processMgr.start({
				command: params.command,
				cwd: params.cwd,
				name: params.name,
				timeoutMs: params.timeoutMs,
				logFile: params.logFile,
			});
			const lines = [
				`Started ${task.id}: ${task.command}`,
				`Status: running. You will be notified with the result when it finishes.`,
				`Use bg_wait to block, bg_status and bg_output to inspect.`,
			];
			if (params.logFile) lines.push(`Full output is also teed to ${params.logFile}.`);
			return { content: textContent(lines.join("\n")), details: snapshotOf(registry) };
		},
	});

	// ---------- bg_wait (R2) ----------
	const BgWaitOutput = Type.Object({
		id: Type.String(),
		exitCode: Type.Union([Type.Number(), Type.Null()]),
		signal: Type.Optional(Type.String()),
		timedOut: Type.Boolean(),
		durationMs: Type.Number(),
		truncated: Type.Boolean(),
		output: Type.String(),
		alsoDelivered: Type.Boolean(),
	});

	/** Race the exit promise against an abort signal and a wait timeout. */
	function raceWait(
		exitPromise: Promise<void>,
		signal: AbortSignal | undefined,
		timeoutMs: number | undefined,
	): Promise<"exited" | "aborted" | "timeout"> {
		return new Promise((resolve) => {
			let settled = false;
			let timer: NodeJS.Timeout | undefined;
			const finish = (outcome: "exited" | "aborted" | "timeout") => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				if (timer) clearTimeout(timer);
				resolve(outcome);
			};
			const onAbort = () => finish("aborted");
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) return finish("aborted");
			if (timeoutMs && timeoutMs > 0) timer = setTimeout(() => finish("timeout"), timeoutMs);
			exitPromise.then(() => finish("exited"));
		});
	}

	pi.registerTool({
		name: "bg_wait",
		label: "Wait for background task",
		namespace: BG_NAMESPACE,
		description:
			"Block until a background task ends. Returns the exit code, the duration, " +
			"and the output tail. An abort cancels the wait, not the task.",
		executionMode: "sequential",
		parameters: Type.Object({
			id: Type.String(),
			timeoutMs: Type.Optional(
				Type.Number({ description: "Give up waiting after this long (task keeps running)" }),
			),
		}),
		outputSchema: BgWaitOutput,
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			registry.captureContext(ctx);
			const task = registry.get(params.id);
			if (!task) {
				return {
					content: textContent(`No background task with id ${params.id}.`),
					details: snapshotOf(registry),
					isError: true,
				};
			}
			// Step 0: the task already ended. Do not wait. This prevents a
			// deadlock on a task that already exited.
			if (task.status === "exited") {
				alerts.releaseIfUndelivered(task);
				return waitedResult(registry, task);
			}
			task.activeWaiters++;
			let outcome: "exited" | "aborted" | "timeout";
			try {
				outcome = await raceWait(task.exitPromise, signal, params.timeoutMs);
			} finally {
				task.activeWaiters--;
			}
			// Step 4 release path: the wait ended without the result, so the
			// tool result carries nothing about the exit. Deliver the alert
			// when the task exited and nobody else will. This prevents a
			// lost completion after a waiter abort.
			if (outcome !== "exited") alerts.releaseIfUndelivered(task);
			if (outcome === "aborted") {
				return {
					content: textContent(`Wait on ${task.id} aborted. The task keeps running. Use bg_status to inspect.`),
					details: snapshotOf(registry),
					isError: true,
				};
			}
			if (outcome === "timeout") {
				return {
					content: textContent(`Wait on ${task.id} timed out. The task keeps running. Use bg_status to inspect.`),
					details: snapshotOf(registry),
				};
			}
			// The exit promise won: the tool result carries the full result,
			// so no alert is necessary (R4 was suppressed by the waiter).
			return waitedResult(registry, task);
		},
	});

	/** Result body for an ended task: text content and structured content share the same tail cap. */
	function waitedResult(registry: TaskRegistry, task: BgTask) {
		const alsoDelivered = task.delivered;
		const output = combinedTail(task, DEFAULT_TAIL_BYTES);
		const durationMs = (task.exitedAt ?? Date.now()) - task.startedAt;
		const lines = [
			`${task.id} ended: ${exitDescription(task)}.`,
			`Duration: ${formatDuration(durationMs)}.`,
			alsoDelivered ? "Note: this result was also delivered as alert." : "",
			task.stdout.truncated || task.stderr.truncated ? "(older output was dropped; the tail buffer keeps the last 64 KiB)" : "",
			`Output tail:`,
			output,
			task.logFile ? `Full log: ${task.logFile}` : "",
		].filter((s) => s.length > 0);
		return {
			content: textContent(lines.join("\n")),
			details: snapshotOf(registry),
			structuredContent: {
				id: task.id,
				exitCode: task.exitCode ?? null,
				...(task.signal ? { signal: task.signal } : {}),
				timedOut: task.timedOut === true,
				durationMs,
				truncated: task.stdout.truncated || task.stderr.truncated,
				output,
				alsoDelivered,
			},
		};
	}

	// ---------- bg_status (R3) ----------
	const BgStatusOutput = Type.Object({
		counts: Type.Object({
			running: Type.Number(),
			done: Type.Number(),
			failed: Type.Number(),
		}),
		tasks: Type.Array(
			Type.Object({
				id: Type.String(),
				command: Type.String(),
				name: Type.Optional(Type.String()),
				status: Type.String(),
				exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
				signal: Type.Optional(Type.String()),
				timedOut: Type.Boolean(),
				runningMs: Type.Number(),
				truncated: Type.Boolean(),
				preview: Type.String(),
			}),
		),
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background task status",
		namespace: BG_NAMESPACE,
		description: "Get the state of one background task, or of all tasks. Omit id for all tasks.",
		executionMode: "sequential",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Specific task; omit = all tasks" })),
		}),
		outputSchema: BgStatusOutput,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			registry.captureContext(ctx);
			let tasks: BgTask[];
			if (params.id) {
				const task = registry.get(params.id);
				if (!task) {
					return {
						content: textContent(`No background task with id ${params.id}.`),
						details: snapshotOf(registry),
						isError: true,
					};
				}
				tasks = [task];
			} else {
				tasks = registry.all();
			}
			if (tasks.length === 0) {
				return {
					content: textContent("No background tasks."),
					details: snapshotOf(registry),
					structuredContent: { counts: { running: 0, done: 0, failed: 0 }, tasks: [] },
				};
			}
			const counts = registry.counts();
			const body = tasks.map(taskLine).join("\n");
			const text = `${body}\nCounts: ${counts.running} running, ${counts.done} done, ${counts.failed} failed.`;
			return {
				content: textContent(text),
				details: snapshotOf(registry),
				structuredContent: {
					counts: { running: counts.running, done: counts.done, failed: counts.failed },
					tasks: tasks.map((t) => ({
						id: t.id,
						command: t.command,
						...(t.name ? { name: t.name } : {}),
						status: t.status,
						...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
						...(t.signal ? { signal: t.signal } : {}),
						timedOut: t.timedOut === true,
						runningMs: (t.exitedAt ?? Date.now()) - t.startedAt,
						truncated: t.stdout.truncated || t.stderr.truncated,
						preview: combinedTail(t, 240),
					})),
				},
			};
		},
	});

	// ---------- bg_output (R3) ----------
	pi.registerTool({
		name: "bg_output",
		label: "Read background task output",
		namespace: BG_NAMESPACE,
		description:
			"Read the captured output tail of a background task. " +
			"Only the last 64 KiB per stream is kept in memory.",
		executionMode: "sequential",
		parameters: Type.Object({
			id: Type.String(),
			stream: Type.Optional(
				Type.String({ enum: ["stdout", "stderr", "combined"], description: "Default: combined" }),
			),
			maxBytes: Type.Optional(Type.Number({ description: "Cap of returned tail bytes (default 8 KiB)" })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			registry.captureContext(ctx);
			const task = registry.get(params.id);
			if (!task) {
				return {
					content: textContent(`No background task with id ${params.id}.`),
					details: snapshotOf(registry),
					isError: true,
				};
			}
			const maxBytes = params.maxBytes && params.maxBytes > 0 ? params.maxBytes : DEFAULT_TAIL_BYTES;
			const stream = params.stream ?? "combined";
			let output: string;
			let truncated: boolean;
			if (stream === "stdout") {
				output = task.stdout.text(maxBytes);
				truncated = task.stdout.truncated;
			} else if (stream === "stderr") {
				output = task.stderr.text(maxBytes);
				truncated = task.stderr.truncated;
			} else {
				output = combinedTail(task, maxBytes);
				truncated = task.stdout.truncated || task.stderr.truncated;
			}
			const lines = [
				`Output of ${task.id} (${stream}, last ${maxBytes} bytes max):`,
				output.length > 0 ? output : "(no output captured)",
				truncated ? "(older output was dropped; the tail buffer keeps the last 64 KiB per stream)" : "",
				task.logFile ? `Full log: ${task.logFile}` : "",
			].filter((s) => s.length > 0);
			return { content: textContent(lines.join("\n")), details: snapshotOf(registry) };
		},
	});

	// ---------- bg_stop (4.5) ----------
	pi.registerTool({
		name: "bg_stop",
		label: "Stop background task",
		namespace: BG_NAMESPACE,
		description:
			"Stop a background task. Sends SIGTERM to the process group and SIGKILL " +
			"after 2 seconds when the group ignores SIGTERM.",
		executionMode: "sequential",
		parameters: Type.Object({
			id: Type.String(),
			signal: Type.Optional(Type.String({ description: "Signal name (default: TERM)" })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			registry.captureContext(ctx);
			const task = registry.get(params.id);
			if (!task) {
				return {
					content: textContent(`No background task with id ${params.id}.`),
					details: snapshotOf(registry),
					isError: true,
				};
			}
			// A signal to a dead process group throws an ESRCH error: no-op instead.
			if (task.status === "exited") {
				return {
					content: textContent(`${task.id} already ended: ${exitDescription(task)}. Nothing to stop.`),
					details: snapshotOf(registry),
				};
			}
			const signalName = params.signal ?? "SIGTERM";
			processMgr.stop(task, signalName.startsWith("SIG") ? signalName : `SIG${signalName}`);
			return {
				content: textContent(`Stopping ${task.id} with ${signalName} (SIGKILL after 2 seconds if it survives).`),
				details: snapshotOf(registry),
			};
		},
	});
}
