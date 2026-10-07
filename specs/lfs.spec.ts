import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertNotLfsPointer, isLfsPointer } from "../src/utils/lfs";

describe("Git LFS pointer detection", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "defender-lfs-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects an unmaterialized LFS pointer and throws an actionable error", () => {
		const p = join(dir, "pointer.onnx");
		writeFileSync(p, "version https://git-lfs.github.com/spec/v1\noid sha256:abc123\nsize 22984052\n");
		expect(isLfsPointer(p)).toBe(true);
		expect(() => assertNotLfsPointer(p)).toThrow(/git lfs pull/);
	});

	it("passes a real binary file", () => {
		const p = join(dir, "real.onnx");
		writeFileSync(p, Buffer.from([0x08, 0x01, 0x12, 0x00, 0xff, 0xfe, 0x00, 0x7f]));
		expect(isLfsPointer(p)).toBe(false);
		expect(() => assertNotLfsPointer(p)).not.toThrow();
	});

	it("treats a missing file as not-a-pointer (the caller surfaces its own error)", () => {
		expect(isLfsPointer(join(dir, "does-not-exist.onnx"))).toBe(false);
	});
});
