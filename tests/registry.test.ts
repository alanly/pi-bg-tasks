import { describe, expect, it } from "vitest";
import { classifyExit, TaskRegistry } from "../src/registry.ts";
import type { BgTask, TaskSummary } from "../src/types.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TailBuffer } from "../src/ringbuf.ts";

function fakeTask(over: Partial<BgTask>): BgTask {
	return {
		id: "bg-1",
		command: "true",
		cwd: "/tmp",
		startedAt: Date.now(),
		status: "running",
		stdout: new TailBuffer(),
		stderr: new TailBuffer(),
		exitPromise: Promise.resolve(),
		activeWaiters: 0,
		delivered: false,
		...over,
	} as BgTask;
}

describe("classifyExit", () => {
	it("exit code 0 is done", () => {
		expect(classifyExit({ status: "exited", exitCode: 0 })).toBe("done");
	});

	it("nonzero exit code is failed", () => {
		expect(classifyExit({ status: "exited", exitCode: 1 })).toBe("failed");
		expect(classifyExit({ status: "exited", exitCode: 127 })).toBe("failed");
	});

	it("kill signal (null exit code) is failed", () => {
		expect(classifyExit({ status: "exited", exitCode: null, signal: "SIGTERM" })).toBe("failed");
	});

	it("timeout is failed even with a zero exit code", () => {
		expect(classifyExit({ status: "exited", exitCode: 0, timedOut: true })).toBe("failed");
	});

	it("refuses a running task", () => {
		expect(() => classifyExit({ status: "running", exitCode: 0 })).toThrow();
	});
});

describe("TaskRegistry", () => {
	it("assigns sequential ids", () => {
		const r = new TaskRegistry();
		expect(r.nextId()).toBe("bg-1");
		expect(r.nextId()).toBe("bg-2");
	});

	it("counts running, done, and failed", () => {
		const r = new TaskRegistry();
		r.add(fakeTask({ id: "bg-1", status: "running" }));
		r.add(fakeTask({ id: "bg-2", status: "exited", exitCode: 0 }));
		r.add(fakeTask({ id: "bg-3", status: "exited", exitCode: 2 }));
		r.add(fakeTask({ id: "bg-4", status: "exited", exitCode: null, signal: "SIGKILL" }));
		expect(r.counts()).toEqual({ running: 1, done: 1, failed: 2 });
	});

	it("captures and returns the context", () => {
		const r = new TaskRegistry();
		const ctx = { mode: "tui" } as unknown as ExtensionContext;
		expect(r.getContext()).toBeUndefined();
		r.captureContext(ctx);
		expect(r.getContext()).toBe(ctx);
	});

	it("snapshots ids, statuses, and counts", () => {
		const r = new TaskRegistry();
		const started = Date.now();
		r.add(fakeTask({ id: "bg-1", status: "exited", exitCode: 0, startedAt: started - 100, exitedAt: started }));
		const snap = r.snapshot();
		expect(snap.counts).toEqual({ running: 0, done: 1, failed: 0 });
		expect(snap.tasks).toHaveLength(1);
		const t: TaskSummary = snap.tasks[0]!;
		expect(t.id).toBe("bg-1");
		expect(t.status).toBe("exited");
		expect(t.runningMs).toBeGreaterThanOrEqual(100);
		expect(t.truncated).toBe(false);
	});

	it("summary flags truncation from either stream", () => {
		const r = new TaskRegistry();
		const task = fakeTask({ id: "bg-1" });
		task.stderr.append("x");
		r.add(task);
		expect(r.summary(task).truncated).toBe(false);
		const big = new TailBuffer(2);
		big.append("abc");
		task.stdout = big;
		expect(r.summary(task).truncated).toBe(true);
	});
});
