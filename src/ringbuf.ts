/**
 * TailBuffer: a fixed-capacity tail buffer for stream output.
 *
 * Keeps only the most recent `capacityBytes` bytes. Tracks `totalBytes`
 * (everything ever appended) and a `truncated` flag (true once old data
 * was dropped). Commands that write unbounded output, for example
 * `npm run dev`, cannot grow memory without control.
 */

import { Buffer } from "node:buffer";

export const DEFAULT_TAIL_CAPACITY = 64 * 1024;

export class TailBuffer {
	/** Total bytes ever appended (before any drop). */
	totalBytes = 0;
	/** True once data was dropped to stay within the capacity. */
	truncated = false;

	private chunks: Buffer[] = [];
	private kept = 0;

	constructor(readonly capacityBytes: number = DEFAULT_TAIL_CAPACITY) {
		if (capacityBytes <= 0) throw new Error("capacityBytes must be positive");
	}

	/** Append a chunk (Buffer or string) to the tail. */
	append(chunk: Buffer | string): void {
		const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
		if (buf.length === 0) return;
		this.totalBytes += buf.length;
		this.chunks.push(buf);
		this.kept += buf.length;
		// Keep exactly the most recent `capacityBytes`: drop or trim oldest chunks.
		while (this.kept > this.capacityBytes) {
			const first = this.chunks[0];
			const excess = this.kept - this.capacityBytes;
			if (first.length > excess) {
				// Partial trim from the head of the oldest chunk.
				this.chunks[0] = first.subarray(excess);
				this.kept -= excess;
			} else {
				this.kept -= first.length;
				this.chunks.shift();
			}
			this.truncated = true;
		}
	}

	/** Bytes currently kept. */
	size(): number {
		return this.kept;
	}

	/**
	 * Decode the kept tail as UTF-8 text. `maxBytes` caps the returned
	 * bytes, taken from the end of the buffer.
	 */
	text(maxBytes: number = Number.POSITIVE_INFINITY): string {
		const want = Math.min(Math.max(maxBytes, 0), this.kept);
		const out: Buffer[] = [];
		let need = want;
		for (let i = this.chunks.length - 1; i >= 0 && need > 0; i--) {
			const c = this.chunks[i];
			if (c.length <= need) {
				out.unshift(c);
				need -= c.length;
			} else {
				out.unshift(c.subarray(c.length - need));
				need = 0;
			}
		}
		return Buffer.concat(out).toString("utf8");
	}
}
