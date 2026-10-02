import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ProcessManager } from "../src/process.ts";
import { TaskRegistry } from "../src/registry.ts";
import { StatusLine } from "../src/statusline.ts";
import { AlertDelivery } from "../src/alerts.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TAIL_CAPACITY } from "../src/ringbuf.ts";

function setup() {
	const pi = { sendMessage: vi.fn().mockResolvedValue(undefined) } as unknown as ExtensionAPI;
	const registry = new TaskRegistry();
	const statusline = new StatusLine(registry);
	const alerts = new AlertDelivery({ pi, registry });
	const mgr = new ProcessManager({ registry, statusline, alerts });
	return { pi, registry, mgr };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
	const d = await mkdtemp(join(tmpdir(), "bg-tasks-"));
	dirs.push(d);
	return d;
}
afterAll(async () => {
	await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
			setTimeout(tick, 25);
		};
		tick();
	});
}

describe("ProcessManager with real processes", () => {
	it("runs a command to completion and finalizes the task", async () => {
		const { mgr, registry, pi } = setup();
		const task = mgr.start({ command: "sleep 0.1 && echo done" });
		expect(task.status).toBe("running");
		expect(registry.get(task.id)).toBe(task);
		await task.exitPromise;
		expect(task.status).toBe("exited");
		expect(task.exitCode).toBe(0);
		expect(task.stdout.text()).toContain("done");
		// No waiter was active: the exit handler delivered one alert.
		await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
		const [msg] = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(msg.customType).toBe("bg-task-complete");
	}, 10000);

	it("suppressed alert while a waiter is active", async () => {
		const { mgr, pi } = setup();
		const task = mgr.start({ command: "sleep 0.2" });
		task.activeWaiters = 1;
		await task.exitPromise;
		expect(pi.sendMessage).not.toHaveBeenCalled();
	}, 10000);

	it("kills a task at the timeout", async () => {
		const { mgr, registry } = setup();
		// bash -lc startup runs login profiles first (~0.5 s here): wait for
		// READY so the timeout hits the running command, not the startup.
		const task = mgr.start({ command: "echo READY; sleep 30", timeoutMs: 2000 });
		const pgid = task.proc!.pid!;
		await waitFor(() => task.stdout.text().includes("READY"));
		await task.exitPromise;
		expect(task.status).toBe("exited");
		expect(task.timedOut).toBe(true);
		expect(task.signal).toBe("SIGTERM");
		expect(task.exitCode).toBeNull();
		expect(registry.counts()).toEqual({ running: 0, done: 0, failed: 1 });
		// The whole group is gone: signaling it throws ESRCH.
		expect(() => process.kill(-pgid, 0)).toThrow();
	}, 10000);

	it("stops a task and its whole group", async () => {
		const { mgr } = setup();
		// A backgrounded child sleeps much longer than the main shell.
		const task = mgr.start({ command: "echo READY; sleep 300 & sleep 300" });
		const pgid = task.proc!.pid!;
		await waitFor(() => task.stdout.text().includes("READY"));
		expect(mgr.stop(task)).toBe(true);
		await task.exitPromise;
		expect(task.status).toBe("exited");
		expect(task.signal).toBe("SIGTERM");
		// Group fully gone shortly after.
		await vi.waitFor(() => expect(() => process.kill(-pgid, 0)).toThrow(), { timeout: 3000 });
	}, 10000);

	it("stop() is a no-op for an exited task", () => {
		const { mgr } = setup();
		const exited = {
			status: "exited",
			proc: undefined,
			killTimer: undefined,
		} as never;
		expect(mgr.stop(exited)).toBe(false);
	});

	it("escalates to SIGKILL when SIGTERM is ignored", async () => {
		const { mgr } = setup();
		// Ignore TERM in the shell and keep looping so only SIGKILL ends it.
		// READY gates the stop: the trap must be armed first (login-shell
		// startup runs before the command string).
		const task = mgr.start({ command: 'trap "" TERM; echo READY; while :; do sleep 0.1; done' });
		await waitFor(() => task.stdout.text().includes("READY"));
		mgr.stop(task);
		await task.exitPromise;
		expect(task.status).toBe("exited");
		expect(task.signal).toBe("SIGKILL");
	}, 10000);

	it("keeps the ring buffer capped under heavy output", async () => {
		const { mgr } = setup();
		const task = mgr.start({ command: "yes abc | head -c 500000" });
		await task.exitPromise;
		expect(task.exitCode).toBe(0);
		expect(task.stdout.totalBytes).toBeGreaterThanOrEqual(500000);
		expect(task.stdout.size()).toBeLessThanOrEqual(DEFAULT_TAIL_CAPACITY);
		expect(task.stdout.truncated).toBe(true);
	}, 15000);

	it("tees full output to a shared logFile in append mode", async () => {
		const { mgr } = setup();
		const dir = await tempDir();
		const log = join(dir, "shared.log");
		const t1 = mgr.start({ command: "echo one", logFile: log });
		const t2 = mgr.start({ command: "echo two", logFile: log });
		await Promise.all([t1.exitPromise, t2.exitPromise]);
		const text = await readFile(log, "utf8");
		expect(text).toContain("one");
		expect(text).toContain("two");
	}, 10000);

	it("shutdownAll kills running tasks and is idempotent", async () => {
		const { mgr, pi } = setup();
		const task = mgr.start({ command: "sleep 300" });
		const pgid = task.proc!.pid!;
		mgr.shutdownAll();
		mgr.shutdownAll(); // second call: no-op
		await task.exitPromise;
		expect(task.status).toBe("exited");
		// Alerts are suppressed during shutdown.
		expect(pi.sendMessage).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(() => process.kill(-pgid, 0)).toThrow(), { timeout: 3000 });
	}, 10000);
});
