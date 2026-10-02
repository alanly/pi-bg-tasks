import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { TaskRegistry } from "../src/registry.ts";
import { StatusLine } from "../src/statusline.ts";
import { AlertDelivery } from "../src/alerts.ts";
import { ProcessManager } from "../src/process.ts";
import { registerTools } from "../src/tools.ts";
import type { BgTask } from "../src/types.ts";
import { TailBuffer } from "../src/ringbuf.ts";

type RawPi = {
	sendMessage: ReturnType<typeof vi.fn>;
	registerTool: ReturnType<typeof vi.fn>;
};

interface Stack {
	rawPi: RawPi;
	registry: TaskRegistry;
	processMgr: ProcessManager;
	tools: Record<string, { execute: (id: string, p: unknown, s: AbortSignal | undefined, u: unknown, ctx: ExtensionToolContext) => Promise<Record<string, unknown>> }>;
	ctx: ExtensionToolContext;
}

function buildStack(): Stack {
	const rawPi: RawPi = {
		sendMessage: vi.fn().mockResolvedValue(undefined),
		registerTool: vi.fn(),
	};
	const pi = rawPi as unknown as ExtensionAPI;
	const registry = new TaskRegistry();
	const statusline = new StatusLine(registry);
	const alerts = new AlertDelivery({ pi, registry });
	const processMgr = new ProcessManager({ registry, statusline, alerts });
	registerTools(pi, { registry, processMgr, alerts });
	const tools = Object.fromEntries(
		rawPi.registerTool.mock.calls.map((c) => [c[0].name, c[0]]),
	) as Stack["tools"];
	const ctx = {
		cwd: "/tmp",
		mode: "json",
		isIdle: () => true,
		ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
	} as unknown as ExtensionToolContext;
	return { rawPi, registry, processMgr, tools, ctx };
}

function run(stack: Stack, tool: string, params: unknown, signal?: AbortSignal) {
	return stack.tools[tool]!.execute("tc-1", params, signal, undefined, stack.ctx);
}

function fakeRunningTask(over: Partial<BgTask> = {}): BgTask {
	let resolveExit!: () => void;
	const exitPromise = new Promise<void>((res) => {
		resolveExit = res;
	});
	return {
		id: "bg-9",
		command: "fake",
		cwd: "/tmp",
		startedAt: Date.now(),
		status: "running",
		stdout: new TailBuffer(),
		stderr: new TailBuffer(),
		exitPromise,
		activeWaiters: 0,
		delivered: false,
		resolveExit,
		...over,
	} as BgTask & { resolveExit: () => void };
}

describe("bg_run", () => {
	it("returns immediately with the id and a running status", async () => {
		const stack = buildStack();
		const res = await run(stack, "bg_run", { command: "sleep 0.1" });
		expect(res.content).toEqual([
			expect.objectContaining({ type: "text", text: expect.stringContaining("bg-1") }),
		]);
		expect((res.content as { text: string }[])[0]!.text).toContain("running");
		expect((res.details as { counts: { running: number } }).counts.running).toBe(1);
		// Clean up the running task.
		stack.processMgr.shutdownAll();
	});
});

describe("completion alerts end to end", () => {
	it("exit with no waiter sends one bg-task-complete message with triggerTurn", async () => {
		const stack = buildStack();
		const res = await run(stack, "bg_run", { command: "sleep 0.1 && echo hi" });
		const id = (res.details as { tasks: Array<{ id: string }> }).tasks[0]!.id;
		await vi.waitFor(() => expect(stack.rawPi.sendMessage).toHaveBeenCalledTimes(1));
		const [msg, opts] = stack.rawPi.sendMessage.mock.calls[0]! as [Record<string, unknown>, Record<string, unknown>];
		expect(msg.customType).toBe("bg-task-complete");
		expect(msg.display).toBe(true);
		expect(opts).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(String(msg.content)).toContain("exit code 0");
		expect((msg.details as { id: string }).id).toBe(id);
	}, 10000);

	it("exit while bg_wait blocks sends no message (the result carries it)", async () => {
		const stack = buildStack();
		await run(stack, "bg_run", { command: "sleep 0.4 && echo hi" });
		const res = await run(stack, "bg_wait", { id: "bg-1" });
		const text = (res.content as { text: string }[])[0]!.text;
		expect(text).toContain("exit code 0");
		expect(text).not.toContain("also delivered");
		expect((res.structuredContent as { exitCode: number; alsoDelivered: boolean }).exitCode).toBe(0);
		expect((res.structuredContent as { alsoDelivered: boolean }).alsoDelivered).toBe(false);
		// No duplicate alert: the resolved wait already carries the result.
		expect(stack.rawPi.sendMessage).not.toHaveBeenCalled();
	}, 15000);

	it("late bg_wait after delivery notes 'also delivered as alert'", async () => {
		const stack = buildStack();
		await run(stack, "bg_run", { command: "sleep 0.1" });
		await vi.waitFor(() => expect(stack.rawPi.sendMessage).toHaveBeenCalledTimes(1));
		const res = await run(stack, "bg_wait", { id: "bg-1" });
		const text = (res.content as { text: string }[])[0]!.text;
		expect(text).toContain("also delivered as alert");
		expect((res.structuredContent as { alsoDelivered: boolean }).alsoDelivered).toBe(true);
		expect(stack.rawPi.sendMessage).toHaveBeenCalledTimes(1); // still exactly one alert
	}, 10000);

	it("waiter abort after the task exit sends the alert anyway (release path)", async () => {
		const stack = buildStack();
		const task = fakeRunningTask();
		stack.registry.add(task);
		const ac = new AbortController();
		const pending = run(stack, "bg_wait", { id: task.id }, ac.signal);
		// The task exits while the waiter is active: the exit handler
		// suppresses the alert. Then the abort wins the race (same tick,
		// before the exit-promise microtask runs): the release path
		// delivers.
		task.status = "exited";
		task.exitCode = 0;
		(task as unknown as { resolveExit: () => void }).resolveExit();
		ac.abort();
		const res = await pending;
		const text = (res.content as { text: string }[])[0]!.text;
		expect(text).toContain("aborted");
		expect(stack.rawPi.sendMessage).toHaveBeenCalledTimes(1);
		expect((stack.rawPi.sendMessage.mock.calls[0]![1] as Record<string, unknown>).triggerTurn).toBe(true);
	});

	it("wait timeout keeps the task running and reports it", async () => {
		const stack = buildStack();
		await run(stack, "bg_run", { command: "sleep 30" });
		const res = await run(stack, "bg_wait", { id: "bg-1", timeoutMs: 150 });
		const text = (res.content as { text: string }[])[0]!.text;
		expect(text).toContain("timed out");
		expect(text).toContain("keeps running");
		expect(stack.registry.get("bg-1")!.status).toBe("running");
		stack.processMgr.stop(stack.registry.get("bg-1")!);
	}, 10000);
});

describe("bg_status", () => {
	it("lists tasks with counts in structuredContent", async () => {
		const stack = buildStack();
		const running = fakeRunningTask({ id: "bg-1" });
		const exited = fakeRunningTask({ id: "bg-2", status: "exited", exitCode: 1 });
		stack.registry.add(running);
		stack.registry.add(exited);
		const res = await run(stack, "bg_status", {});
		expect((res.structuredContent as { counts: { running: number; failed: number } }).counts).toEqual({
			running: 1,
			done: 0,
			failed: 1,
		});
		expect((res.structuredContent as { tasks: unknown[] }).tasks).toHaveLength(2);
	}, 10000);

	it("filters by id and reports unknown ids", async () => {
		const stack = buildStack();
		stack.registry.add(fakeRunningTask({ id: "bg-1" }));
		const res = await run(stack, "bg_status", { id: "bg-1" });
		expect((res.structuredContent as { tasks: unknown[] }).tasks).toHaveLength(1);
		const missing = await run(stack, "bg_status", { id: "bg-42" });
		expect(missing.isError).toBe(true);
	}, 10000);
});

describe("bg_output", () => {
	it("returns the stream tail and honors maxBytes", async () => {
		const stack = buildStack();
		const task = fakeRunningTask({ id: "bg-1", status: "exited", exitCode: 0 });
		task.stdout.append("out-12345678");
		task.stderr.append("err-data");
		stack.registry.add(task);
		const res = await run(stack, "bg_output", { id: "bg-1", stream: "stdout", maxBytes: 5 });
		const text = (res.content as { text: string }[])[0]!.text;
		expect(text).toContain("5678");
		expect(text).not.toContain("out-1");
		const combined = await run(stack, "bg_output", { id: "bg-1" });
		const ctext = (combined.content as { text: string }[])[0]!.text;
		expect(ctext).toContain("err-data");
		expect(ctext).toContain("out-12345678");
		const missing = await run(stack, "bg_output", { id: "bg-42" });
		expect(missing.isError).toBe(true);
	}, 10000);
});

describe("bg_stop", () => {
	it("no-ops on an exited task with an explanatory result", async () => {
		const stack = buildStack();
		stack.registry.add(fakeRunningTask({ id: "bg-1", status: "exited", exitCode: 0 }));
		const res = await run(stack, "bg_stop", { id: "bg-1" });
		const text = (res.content as { text: string }[])[0]!.text;
		expect(text).toContain("already ended");
		expect(text).toContain("Nothing to stop");
	}, 10000);

	it("stops a running task and reports the escalation", async () => {
		const stack = buildStack();
		await run(stack, "bg_run", { command: "sleep 30" });
		const res = await run(stack, "bg_stop", { id: "bg-1" });
		const text = (res.content as { text: string }[])[0]!.text;
		expect(text).toContain("Stopping bg-1");
		await stack.registry.get("bg-1")!.exitPromise;
		expect(stack.registry.get("bg-1")!.status).toBe("exited");
	}, 10000);
});
