/**
 * Completion alerts (R4). When a task ends and no bg_wait call is
 * active, deliver the result to the model as a custom message that
 * triggers a new turn. The delivered flag gives exactly one alert per
 * task.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BgTask } from "./types.ts";
import { CT_BG_COMPLETE } from "./types.ts";
import type { TaskRegistry } from "./registry.ts";

/** Keep the content sent to the model at 4 KiB or less. */
export const MODEL_ALERT_CAP = 4 * 1024;
/** Budget for the output tail inside the alert (the rest is the header). */
export const ALERT_TAIL_BUDGET = 3 * 1024;

/** Human-friendly duration. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
	const min = Math.floor(ms / 60_000);
	const sec = Math.round((ms % 60_000) / 1000);
	return sec ? `${min} min ${sec} s` : `${min} min`;
}

/** Short text that says how the task ended. */
export function exitDescription(task: BgTask): string {
	if (task.spawnError) return `spawn failed: ${task.spawnError}`;
	if (task.timedOut) return "killed: timeout";
	if (task.signal) return `killed by signal ${task.signal}`;
	return `exit code ${task.exitCode}`;
}

/** True when either tail buffer dropped data. */
function truncated(task: BgTask): boolean {
	return task.stdout.truncated || task.stderr.truncated;
}

/**
 * Model-facing alert text: id, command, exit result, duration, and the
 * last lines of output. Notes that bg_output gives the full output.
 */
export function formatResultForModel(task: BgTask): string {
	const label = task.name ? `${task.id} (${task.name})` : task.id;
	const duration = formatDuration((task.exitedAt ?? Date.now()) - task.startedAt);
	const head = [
		`Background task ${label} finished: ${exitDescription(task)}.`,
		`Duration: ${duration}.`,
		`Command: ${task.command}`,
		"",
	].join("\n");
	const tail = [
		task.stderr.text(ALERT_TAIL_BUDGET),
		task.stdout.text(ALERT_TAIL_BUDGET),
	].filter((s) => s.length > 0).join("\n");
	const footer = [
		"",
		truncated(task) ? "(older output was dropped; the tail buffer keeps the last 64 KiB)" : "",
		`Use bg_output on ${task.id} for the full tail.`,
		task.logFile ? `Full log: ${task.logFile}` : "",
	]
		.filter((s) => s.length > 0)
		.join("\n");
	let text = [head, tail, footer].filter((s) => s.length > 0).join("\n");
	// Safety: never exceed the model alert cap.
	if (Buffer.byteLength(text, "utf8") > MODEL_ALERT_CAP) {
		text = Buffer.from(text, "utf8").subarray(0, MODEL_ALERT_CAP).toString("utf8");
	}
	return text;
}

export interface AlertDeliveryDeps {
	pi: ExtensionAPI;
	registry: TaskRegistry;
}

export class AlertDelivery {
	constructor(private deps: AlertDeliveryDeps) {}

	/**
	 * Deliver the completion alert. Sends a custom message that triggers
	 * a new turn, and notifies the user in the TUI. Idempotent through
	 * the delivered flag.
	 */
	deliver(task: BgTask): void {
		if (task.status !== "exited" || task.delivered) return;
		task.delivered = true;
		const ctx = this.deps.registry.getContext();
		const content = formatResultForModel(task);
		this.deps.pi.sendMessage(
			{
				customType: CT_BG_COMPLETE,
				content,
				display: true,
				details: {
					id: task.id,
					name: task.name,
					command: task.command,
					exitCode: task.exitCode,
					signal: task.signal,
					timedOut: task.timedOut,
					durationMs: (task.exitedAt ?? task.startedAt) - task.startedAt,
					truncated: truncated(task),
					logFile: task.logFile,
				},
			},
			{
				triggerTurn: true,
				deliverAs: ctx?.isIdle() ? "followUp" : "nextTurn",
			},
		);
		// Tell the human user too, when a TUI exists.
		if (ctx && ctx.mode === "tui") {
			const what = task.name ?? task.command;
			ctx.ui.notify(`bg task finished: ${what} (${exitDescription(task)})`);
		}
	}

	/**
	 * Release-path check for bg_wait: after a waiter ends (resolve,
	 * abort, or timeout), deliver the alert when the task exited, the
	 * alert was not sent, and no other waiter is active. This prevents
	 * a lost completion after a waiter abort.
	 */
	releaseIfUndelivered(task: BgTask): void {
		if (task.status === "exited" && !task.delivered && task.activeWaiters === 0) {
			this.deliver(task);
		}
	}
}
