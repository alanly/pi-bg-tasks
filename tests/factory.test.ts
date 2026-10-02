import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

// Import after the mock.
const factory = (await import("../index.ts")).default;

function mockPi() {
	const calls = {
		tools: [] as Array<{ name: string; namespace?: { name: string }; executionMode?: string }>,
		renderers: [] as Array<[customType: string, renderer: unknown]>,
		events: [] as Array<[event: string, handler: unknown]>,
	};
	const pi = {
		registerTool: vi.fn((t: never) => {
			calls.tools.push(t);
		}),
		registerMessageRenderer: vi.fn((...args: [string, unknown]) => {
			calls.renderers.push(args);
		}),
		on: vi.fn((event: string, handler: unknown) => {
			calls.events.push([event, handler]);
		}),
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

describe("factory smoke test", () => {
	it("registers five bg tools, the renderer, and the lifecycle handlers", () => {
		const { pi, calls } = mockPi();
		expect(() => factory(pi)).not.toThrow();
		expect(calls.tools.map((t) => t.name)).toEqual(["bg_run", "bg_wait", "bg_status", "bg_output", "bg_stop"]);
		for (const t of calls.tools) {
			expect(t.namespace?.name).toBe("bg");
			expect(t.executionMode).toBe("sequential");
		}
		expect(calls.renderers.map(([t]) => t)).toEqual(["bg-task-complete"]);
		expect(calls.events.map(([e]) => e)).toEqual(["session_start", "session_shutdown"]);
	});

	it("starts no process in the factory", () => {
		const { pi } = mockPi();
		factory(pi);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
