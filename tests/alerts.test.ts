import { describe, expect, it, vi } from "vitest";
import { AlertDelivery, formatResultForModel, MODEL_ALERT_CAP } from "../src/alerts.ts";
import { TaskRegistry } from "../src/registry.ts";
import type { BgTask } from "../src/types.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TailBuffer } from "../src/ringbuf.ts";

function fakePi() {
	const sendMessage = vi.fn().mockResolvedValue(undefined);
	return { sendMessage };
}

type RawPi = { sendMessage: ReturnType<typeof vi.fn> };

type MockNotify = ReturnType<typeof vi.fn>;

function fakeCtx(over: Record<string, unknown> = {}) {
	return {
		mode: "tui",
		isIdle: () => true,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			theme: { fg: (_c: string, t: string) => t },
		},
		...over,
	} as unknown as ExtensionContext;
}

function exitedTask(over: Partial<BgTask> = {}): BgTask {
	return {
		id: "bg-1",
		command: "npm test",
		cwd: "/tmp",
		startedAt: Date.now() - 1200,
		exitedAt: Date.now(),
		status: "exited",
		exitCode: 0,
		stdout: new TailBuffer(),
		stderr: new TailBuffer(),
		exitPromise: Promise.resolve(),
		activeWaiters: 0,
		delivered: false,
		...over,
	} as BgTask;
}

function setup(ctx?: ExtensionContext) {
	const rawPi: RawPi = fakePi();
	const pi = rawPi as unknown as ExtensionAPI;
	const registry = new TaskRegistry();
	if (ctx) registry.captureContext(ctx);
	const alerts = new AlertDelivery({ pi, registry });
	return { pi: rawPi, registry, alerts };
}

describe("AlertDelivery", () => {
	it("delivers one alert with triggerTurn when idle", () => {
		const ctx = fakeCtx();
		const { pi, registry, alerts } = setup(ctx);
		const task = exitedTask();
		registry.add(task);
		alerts.deliver(task);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [msg, opts] = pi.sendMessage.mock.calls[0]!;
		expect(msg.customType).toBe("bg-task-complete");
		expect(msg.display).toBe(true);
		expect(msg.content).toContain("bg-1");
		expect(msg.content).toContain("exit code 0");
		expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
	});

	it("queues with nextTurn when the agent is busy", () => {
		const ctx = fakeCtx({ isIdle: () => false });
		const { pi, alerts } = setup(ctx);
		const task = exitedTask();
		alerts.deliver(task);
		const [, opts] = pi.sendMessage.mock.calls[0]!;
		expect(opts.deliverAs).toBe("nextTurn");
	});

	it("sends exactly one alert per task (dedupe)", () => {
		const { pi, alerts } = setup(fakeCtx());
		const task = exitedTask();
		alerts.deliver(task);
		alerts.deliver(task);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("ignores a running task", () => {
		const { pi, alerts } = setup(fakeCtx());
		const task = exitedTask({ status: "running", exitCode: undefined });
		alerts.deliver(task);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does not notify without a TUI", () => {
		const ctx = fakeCtx({ mode: "json" });
		const { pi, alerts } = setup(ctx);
		alerts.deliver(exitedTask());
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		expect((ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
	});

	it("releaseIfUndelivered respects waiters and the delivered flag", () => {
		const { pi, alerts } = setup(fakeCtx());
		const waiting = exitedTask({ activeWaiters: 1 });
		alerts.releaseIfUndelivered(waiting);
		expect(pi.sendMessage).not.toHaveBeenCalled();

		waiting.activeWaiters = 0;
		alerts.releaseIfUndelivered(waiting);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// Delivered already: no second alert.
		alerts.releaseIfUndelivered(waiting);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);

		// Running task: nothing to release.
		const running = exitedTask({ status: "running", exitCode: undefined });
		alerts.releaseIfUndelivered(running);
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

describe("formatResultForModel", () => {
	it("includes id, command, exit code, and the bg_output pointer", () => {
		const task = exitedTask();
		const text = formatResultForModel(task);
		expect(text).toContain("bg-1");
		expect(text).toContain("npm test");
		expect(text).toContain("exit code 0");
		expect(text).toContain("Use bg_output on bg-1");
	});

	it("mentions the log file when one exists", () => {
		const text = formatResultForModel(exitedTask({ logFile: "/tmp/x.log" }));
		expect(text).toContain("Full log: /tmp/x.log");
	});

	it("reports signals and timeouts", () => {
		expect(formatResultForModel(exitedTask({ timedOut: true }))).toContain("killed: timeout");
		expect(formatResultForModel(exitedTask({ exitCode: null, signal: "SIGKILL" }))).toContain("killed by signal SIGKILL");
	});

	it("stays within the 4 KiB model cap", () => {
		const task = exitedTask();
		const big = new TailBuffer(1024 * 1024);
		big.append(Buffer.alloc(512 * 1024, 0x61)); // "aaaa..."
		task.stdout = big;
		task.stderr = big;
		const text = formatResultForModel(task);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MODEL_ALERT_CAP);
	});
});
