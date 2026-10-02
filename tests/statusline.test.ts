import { describe, expect, it } from "vitest";
import { formatLine } from "../src/statusline.ts";

const identity = (_c: string, t: string) => t;

describe("formatLine", () => {
	it("shows running only", () => {
		expect(formatLine({ running: 1, done: 0, failed: 0 }, identity)).toBe("🧵 bg: 1 running");
		expect(formatLine({ running: 2, done: 0, failed: 0 }, identity)).toBe("🧵 bg: 2 running");
	});

	it("joins all segments with ' · '", () => {
		expect(formatLine({ running: 2, done: 1, failed: 1 }, identity)).toBe("🧵 bg: 2 running · 1 done · 1 failed");
	});

	it("omits each zero segment", () => {
		expect(formatLine({ running: 0, done: 2, failed: 0 }, identity)).toBe("🧵 bg: 2 done");
		expect(formatLine({ running: 0, done: 0, failed: 1 }, identity)).toBe("🧵 bg: 1 failed");
		expect(formatLine({ running: 0, done: 0, failed: 0 }, identity)).toBeUndefined();
	});

	it("passes theme colors per segment", () => {
		const seen: Array<[string, string]> = [];
		const fg = (c: string, t: string) => {
			seen.push([c, t]);
			return t;
		};
		formatLine({ running: 1, done: 1, failed: 1 }, fg);
		expect(seen).toEqual([
			["accent", "1 running"],
			["success", "1 done"],
			["error", "1 failed"],
		]);
	});
});
