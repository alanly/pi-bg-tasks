import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { TailBuffer } from "../src/ringbuf.ts";

describe("TailBuffer", () => {
	it("keeps everything under the capacity", () => {
		const b = new TailBuffer(100);
		b.append("hello");
		b.append(" world");
		expect(b.text()).toBe("hello world");
		expect(b.size()).toBe(11);
		expect(b.totalBytes).toBe(11);
		expect(b.truncated).toBe(false);
	});

	it("drops oldest data at the cap and sets truncated", () => {
		const b = new TailBuffer(10);
		b.append("aaaa"); // 4
		expect(b.truncated).toBe(false);
		b.append("bbbbbb"); // 10 total: still exact fit
		expect(b.size()).toBe(10);
		expect(b.truncated).toBe(false);
		b.append("cc"); // 12: trim 2 bytes from the head -> "aabbbbbbcc"
		expect(b.truncated).toBe(true);
		expect(b.text()).toBe("aabbbbbbcc");
		expect(b.size()).toBe(10);
		expect(b.totalBytes).toBe(12);
	});

	it("trims a single chunk larger than the capacity", () => {
		const b = new TailBuffer(5);
		b.append(Buffer.from("0123456789")); // 10 bytes, one chunk
		expect(b.size()).toBe(5);
		expect(b.truncated).toBe(true);
		expect(b.text()).toBe("56789");
		expect(b.totalBytes).toBe(10);
	});

	it("counts bytes, not characters, for multi-byte input", () => {
		const b = new TailBuffer(4);
		b.append("éééé"); // 8 bytes
		expect(b.size()).toBe(4);
		expect(b.truncated).toBe(true);
		expect(b.totalBytes).toBe(8);
	});

	it("text(maxBytes) returns at most maxBytes from the end", () => {
		const b = new TailBuffer(1000);
		b.append("0123456789");
		expect(b.text(4)).toBe("6789");
		expect(b.text(100)).toBe("0123456789");
		expect(b.text(0)).toBe("");
	});

	it("text(maxBytes) caps from the end across dropped chunks", () => {
		const b = new TailBuffer(8);
		b.append("abcdef"); // 6
		b.append("ghij"); // 10 > 8: drop "ab" -> "cdefghij"
		expect(b.text()).toBe("cdefghij");
		expect(b.text(3)).toBe("hij");
	});

	it("ignores empty chunks", () => {
		const b = new TailBuffer(10);
		b.append("");
		b.append(Buffer.alloc(0));
		expect(b.size()).toBe(0);
		expect(b.totalBytes).toBe(0);
		expect(b.truncated).toBe(false);
	});

	it("rejects a non-positive capacity", () => {
		expect(() => new TailBuffer(0)).toThrow();
	});
});
