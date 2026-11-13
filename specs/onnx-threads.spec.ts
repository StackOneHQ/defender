import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn(async () => ({ run: async () => ({}) }));
vi.mock("onnxruntime-node", () => ({ InferenceSession: { create }, Tensor: class {} }));

const { OnnxClassifier } = await import("../src/classifiers/onnx-classifier");
const modelPath = resolve(__dirname, "../src/classifiers/models/minilm-multihead-v5");

describe("#OnnxClassifier onnxThreads session options", () => {
	beforeEach(() => create.mockClear());

	it("passes the thread count to ONNX Runtime and keeps one session per count", async () => {
		await new OnnxClassifier(modelPath, undefined, undefined, 2).loadModel();
		await new OnnxClassifier(modelPath, undefined, undefined, 2).loadModel();
		await new OnnxClassifier(modelPath).loadModel();
		expect(create.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
			{ intraOpNumThreads: 2, interOpNumThreads: 1 },
			undefined,
		]);
	});

	it("names a string value in the error", () => {
		expect(() => new OnnxClassifier(modelPath, undefined, undefined, "1" as unknown as number)).toThrow('got "1"');
	});
});
