import { afterEach, describe, expect, it, vi } from "vitest";
import { Tier2Classifier } from "../src/classifiers/tier2-classifier";
import { createPromptDefense } from "../src/core/prompt-defense";

// Model-free: Tier 2 is stubbed, so these run in CI. The integration spec covers the real model.
const BENIGN = "The borrower has unrestricted access to the accounts.";

function stubTier2(score: number, chunk: (text: string) => string[] = (t) => [t]) {
	vi.spyOn(Tier2Classifier.prototype, "warmup").mockResolvedValue();
	vi.spyOn(Tier2Classifier.prototype, "isReady").mockReturnValue(true);
	vi.spyOn(Tier2Classifier.prototype, "prepareChunks").mockImplementation(async (text: string) => ({
		chunks: chunk(text),
		skipped: false,
	}));
	vi.spyOn(Tier2Classifier.prototype, "classifyChunksBatch").mockImplementation(async (chunks: string[]) =>
		chunks.map(() => score),
	);
}

const run = (value: unknown) =>
	createPromptDefense({ blockHighRisk: true }).defendToolResult(value, "generic_get_record");

describe("Tier 1 gate (Tier 2 stubbed)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("gates a Tier 1 match that Tier 2 read and scored low", async () => {
		stubTier2(0.05);
		const r = await run({ description: BENIGN });
		expect(r.tier1Gated).toBe(true);
		expect(r.allowed).toBe(true);
	});

	it("keeps Tier 1's block when Tier 2 agrees", async () => {
		stubTier2(0.4);
		const r = await run({ description: BENIGN });
		expect(r.tier1Gated).toBeUndefined();
		expect(r.allowed).toBe(false);
	});

	it("keeps Tier 1's block on a non-finite chunk score", async () => {
		stubTier2(Number.NaN);
		const r = await run({ description: BENIGN });
		expect(r.tier1Gated).toBeUndefined();
		expect(r.allowed).toBe(false);
	});

	it("doesn't count the phrase read from another field's chunk", async () => {
		stubTier2(0.05, (t) => {
			const i = t.indexOf("restricted");
			return t.startsWith("The borrower") ? [t.slice(0, i), t.slice(i)] : [t];
		});
		const r = await run({ description: BENIGN, notes: "Note that unrestricted access needs approval." });
		expect(r.tier1Gated).toBeUndefined();
		expect(r.allowed).toBe(false);
	});

	it("needs every occurrence of the phrase in a chunk", async () => {
		stubTier2(0.05, () => [BENIGN]);
		const r = await run({ description: `${BENIGN} ${BENIGN}` });
		expect(r.tier1Gated).toBeUndefined();
		expect(r.allowed).toBe(false);
	});

	it("keeps Tier 1's block when no chunk holds the matched phrase whole", async () => {
		stubTier2(0.05, (t) => {
			const i = t.indexOf("restricted");
			return [t.slice(0, i), t.slice(i)];
		});
		const r = await run({ description: BENIGN });
		expect(r.tier1Gated).toBeUndefined();
		expect(r.allowed).toBe(false);
	});
});
