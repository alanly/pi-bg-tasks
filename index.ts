/**
 * pi-bg-tasks — run shell commands as non-blocking background tasks.
 *
 * Entry point. Wires the TaskRegistry, the StatusLine, the AlertDelivery,
 * the ProcessManager, the five bg_* tools, the completion message
 * renderer, and the lifecycle handlers.
 *
 * Lifecycle rules: the factory starts no process and no timer. Processes
 * start only in tool execute(). The session_shutdown handler kills all
 * running task groups and is idempotent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { TaskRegistry } from "./src/registry.ts";
import { StatusLine } from "./src/statusline.ts";
import { AlertDelivery, exitDescription, formatDuration } from "./src/alerts.ts";
import { ProcessManager } from "./src/process.ts";
import { registerTools } from "./src/tools.ts";
import { CT_BG_COMPLETE } from "./src/types.ts";

interface BgCompleteDetails {
	id: string;
	name?: string;
	command: string;
	exitCode?: number | null;
	signal?: string;
	timedOut?: boolean;
	durationMs: number;
	truncated: boolean;
	logFile?: string;
}

export default function (pi: ExtensionAPI) {
	const registry = new TaskRegistry();
	const statusline = new StatusLine(registry);
	const alerts = new AlertDelivery({ pi, registry });
	const processMgr = new ProcessManager({ registry, statusline, alerts });

	registerTools(pi, { registry, processMgr, alerts });

	// TUI renderer: green check for exit 0, red cross otherwise, id and
	// command in dim text.
	pi.registerMessageRenderer<BgCompleteDetails>(CT_BG_COMPLETE, (message, _options, theme) => {
		const d = (message.details ?? {}) as BgCompleteDetails;
		const ok = d.exitCode === 0 && !d.timedOut;
		const mark = theme.fg(ok ? "success" : "error", ok ? "✔" : "✘");
		const label = d.name ? `${d.id} (${d.name})` : d.id;
		const how =
			d.exitCode === 0
				? `exit 0, ${formatDuration(d.durationMs)}`
				: `${exitDescription({ exitCode: d.exitCode, signal: d.signal, timedOut: d.timedOut } as never)}, ${formatDuration(d.durationMs)}`;
		const rest = theme.fg("dim", ` bg ${label}: ${d.command ?? ""} (${how})`);
		return new Text(mark + rest, 0, 0);
	});

	// ctx is not a factory parameter: capture it at session_start. Pi fires
	// session_start again after a session switch, so the copy stays fresh.
	pi.on("session_start", async (_event, ctx) => {
		registry.captureContext(ctx);
		statusline.refresh();
	});
	// Idempotent cleanup: kill all task groups, SIGKILL after the grace period.
	pi.on("session_shutdown", async () => {
		processMgr.shutdownAll();
	});
}
