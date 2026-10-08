import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OnnxClassifier } from "../src/classifiers/onnx-classifier";
import { assertNotLfsPointer, isLfsPointer } from "../src/utils/lfs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POINTER = "version https://git-lfs.github.com/spec/v1\noid sha256:abc123\nsize 22984052\n";

describe("Git LFS pointer detection (runtime util)", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "defender-lfs-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects an unmaterialized LFS pointer and throws an actionable error", () => {
		const p = join(dir, "pointer.onnx");
		writeFileSync(p, POINTER);
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

describe("build guard (scripts/copy-models.cjs)", () => {
	const require = createRequire(import.meta.url);
	const { assertRealModel, validateModelsUnder } = require("../scripts/copy-models.cjs");
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "defender-copy-"));
	});
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws on a pointer model (not shipped)", () => {
		const p = join(dir, "pointer.onnx");
		writeFileSync(p, POINTER);
		expect(() => assertRealModel(p)).toThrow(/git lfs pull/);
	});

	it("throws on a truncated/undersized model below the per-extension floor", () => {
		const onnx = join(dir, "small.onnx"); // floor 1_000_000
		writeFileSync(onnx, Buffer.alloc(500_000, 0x08));
		expect(() => assertRealModel(onnx)).toThrow(/truncated|git lfs pull/);
		const ftz = join(dir, "small.ftz"); // floor 100_000
		writeFileSync(ftz, Buffer.alloc(50_000, 0x01));
		expect(() => assertRealModel(ftz)).toThrow(/truncated|git lfs pull/);
	});

	it("passes a real-sized binary", () => {
		const p = join(dir, "ok.onnx");
		writeFileSync(p, Buffer.alloc(1_100_000, 0x08));
		expect(() => assertRealModel(p)).not.toThrow();
	});

	it("validateModelsUnder flags a nested pointer and ignores non-model files", () => {
		const sub = mkdtempSync(join(dir, "tree-"));
		writeFileSync(join(sub, "tokenizer.json"), "{}"); // tiny non-model file must be ignored
		writeFileSync(join(sub, "model_quantized.onnx"), POINTER);
		expect(() => validateModelsUnder(sub)).toThrow(/git lfs pull/);
	});

	it("run() fails when a model dir is missing the required ONNX entirely (partial checkout)", () => {
		const { run } = require("../scripts/copy-models.cjs");
		// Model dir exists with configs but NO model_quantized.onnx — validateModelsUnder alone wouldn't catch it.
		const modelDir = join(dir, "src", "classifiers", "models", "minilm-multihead-v5");
		mkdirSync(modelDir, { recursive: true });
		writeFileSync(join(modelDir, "config.json"), "{}");
		expect(() => run(dir)).toThrow(/missing required model file/);
	});
});

describe("ONNX load wiring", () => {
	it("rejects with an actionable error when model_quantized.onnx is an LFS pointer", async () => {
		const realDir = resolve(HERE, "../src/classifiers/models/minilm-multihead-v5");
		const tmp = mkdtempSync(join(tmpdir(), "defender-onnx-"));
		// Copy the real tokenizer/config (loaded before the guard) so the guard is what fails.
		for (const f of ["classifier_config.json", "config.json", "tokenizer.json", "tokenizer_config.json"]) {
			copyFileSync(join(realDir, f), join(tmp, f));
		}
		writeFileSync(join(tmp, "model_quantized.onnx"), POINTER);
		await expect(new OnnxClassifier(tmp).loadModel()).rejects.toThrow(/git lfs pull/);
		rmSync(tmp, { recursive: true, force: true });
	}, 20000);
});
