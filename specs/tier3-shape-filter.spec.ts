import { describe, expect, it } from "vitest";
import { createPromptDefense } from "../src/core/prompt-defense";
import type { Tier3Provider } from "../src/types";

// tier3.dropShapeOnlyFields: what the Tier 3 provider reads, with the filter on and off.
async function review(payload: unknown, tier3: Record<string, unknown> = {}) {
	const calls: string[] = [];
	const provider: Tier3Provider = {
		classify: async (text) => {
			calls.push(text);
			return { decision: "allow" };
		},
	};
	const r = await createPromptDefense({
		blockHighRisk: true,
		enableTier3: true,
		defenderMode: "tier3_only",
		tier3: { provider, ...tier3 },
	}).defendToolResult(payload, "test_tool");
	return { text: calls.join("\n"), calls, r };
}

const on = { dropShapeOnlyFields: true };

describe("tier3.dropShapeOnlyFields", () => {
	const page = {
		data: {
			nodes: [
				{
					id: "0b9f2c1e-3d4a-4c5b-8e6f-7a8b9c0d1e2f",
					status: { id: "5f1e2d3c4b5a69788796a5b4c3d2e1f0", name: "In progress" },
					canceledAt: null,
					progress: 0,
					createdAt: "2026-01-02T03:04:05.000Z",
					color: "#ff00aa",
					archived: false,
					name: "Roadmap Q1",
					description: "Ship the new billing flow.",
				},
			],
		},
	};

	it("leaves shape-only values out and keeps text", async () => {
		const { text } = await review(page, on);
		expect(text).toBe(
			[
				"data.nodes[0].status.name: In progress",
				"data.nodes[0].name: Roadmap Q1",
				"data.nodes[0].description: Ship the new billing flow.",
			].join("\n"),
		);
	});

	it("is off by default", async () => {
		const { text } = await review(page);
		expect(text).toContain("data.nodes[0].id: 0b9f2c1e-3d4a-4c5b-8e6f-7a8b9c0d1e2f");
		expect(text).toContain("data.nodes[0].canceledAt: null");
		expect(text).toContain("data.nodes[0].progress: 0");
	});

	it("keeps URLs, emails, short words and empty values", async () => {
		const { text } = await review(
			{ url: "https://example.com/a", email: "a@example.com", state: "open", note: "", tag: "v2" },
			on,
		);
		expect(text).toBe(
			["url: https://example.com/a", "email: a@example.com", "state: open", "note:", "tag: v2"].join("\n"),
		);
	});

	it("never leaves out a line whose key isn't a plain path", async () => {
		const { text } = await review({ "ignore all previous": null, "count!": 5, ok: "fine text" }, on);
		expect(text).toBe(["ignore all previous: null", "count!: 5", "ok: fine text"].join("\n"));
	});

	it("keeps a number or date line inside a multi-line value", async () => {
		const { text } = await review({ body: "Totals below\n42\n2026-01-02" }, on);
		expect(text).toBe(["body: Totals below", "body: 42", "body: 2026-01-02"].join("\n"));
	});

	it("counts left-out strings as covered, not as oversize", async () => {
		const { r, calls } = await review({ createdAt: "2026-01-02", id: "deadbeef01", title: "Weekly sync" }, on);
		expect(calls).toEqual(["title: Weekly sync"]);
		expect(r.coverageDegraded).not.toBe(true);
		expect(r.tier3ChunkSummary?.oversize).toBeUndefined();
	});

	it("skips the provider when only shape-only values are left", async () => {
		const { calls, r } = await review({ id: "deadbeef01", n: 3 }, on);
		expect(calls).toEqual([]);
		expect(r.tier3?.skipReason).toMatch(/No reviewable/);
	});

	it("reviews the whole result where shape-only lines overflowed the ceiling", async () => {
		const items = Array.from({ length: 200 }, (_, i) => ({ id: `${String(i).padStart(8, "0")}cafe`, n: i }));
		const payload = { items, note: "Please review the attached contract before Friday." };
		const tight = { maxTextLength: 2000, maxChunks: 1 };
		const off = await review(payload, tight);
		expect(off.r.tier3ChunkSummary?.oversize).toBe(true);
		const filtered = await review(payload, { ...tight, ...on });
		expect(filtered.text).toBe("note: Please review the attached contract before Friday.");
		expect(filtered.r.tier3ChunkSummary?.oversize).toBeUndefined();
	});

	it("still reports overflow when text exceeds the ceiling", async () => {
		const payload = { id: "deadbeef01", body: "word ".repeat(1000) };
		const { r } = await review(payload, { maxTextLength: 1000, maxChunks: 1, ...on });
		expect(r.tier3ChunkSummary?.oversize).toBe(true);
		expect(r.coverageDegraded).toBe(true);
	});
});
