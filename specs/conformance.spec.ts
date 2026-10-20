/**
 * Runs the shared conformance fixtures in conformance/*.json against the public API.
 * The Python package runs the same files (pinned copy); see conformance/README.md.
 *
 * Regenerate expected outputs after an intentional behavior change:
 *   CONFORMANCE_UPDATE=1 pnpm vitest run specs/conformance.spec.ts
 * then review the JSON diff.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	buildTier3Messages,
	createLlmTier3Provider,
	createPromptDefense,
	DEFAULT_TIER3_PROMPT,
	type DefenseResult,
	type PromptDefenseOptions,
	parseVerdictJson,
	type Tier3PromptTemplate,
	type Tier3Provider,
} from "../src/index";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "conformance");
const FORMAT_VERSION = 1;
const MARKER_RE = /(<<<(?:END_)?[A-Z_]+ id=)([0-9a-f]{16})(>>>)/g;

/**
 * Replace each real marker id with <ID1>, <ID2>… by first appearance across all messages, so the
 * fixture still pins that an open/close pair shares an id and that separate blocks get separate ids.
 */
function normalizeIds(contents: string[]): string[] {
	const ids = new Map<string, string>();
	return contents.map((c) =>
		c.replace(MARKER_RE, (_m, pre: string, id: string, post: string) => {
			if (!ids.has(id)) ids.set(id, `<ID${ids.size + 1}>`);
			return `${pre}${ids.get(id)}${post}`;
		}),
	);
}
const UPDATE = process.env.CONFORMANCE_UPDATE === "1";

// biome-ignore lint/suspicious/noExplicitAny: fixture input is untyped JSON, shaped per area
type FixtureInput = any;
type Case = { id: string; description?: string; requiresTier2?: boolean; input: FixtureInput; expect?: unknown };
type Fixture = { version: number; area: string; description: string; cases: Case[] };

type JudgeVerdict = Record<string, unknown> | { throw: string };
type Judge = { default: JudgeVerdict; rules?: Array<{ ifContains: string; then: JudgeVerdict }> };

/** A provider that answers from a declarative script, so fixtures stay language-neutral. */
function scriptedJudge(judge: Judge, counter?: { calls: number }): Tier3Provider {
	return {
		classify: async (text) => {
			if (counter) counter.calls++;
			const v = judge.rules?.find((r) => text.includes(r.ifContains))?.then ?? judge.default;
			if ("throw" in v) throw new Error(String(v.throw));
			return v as never;
		},
	};
}

const pickTier3 = (t: DefenseResult["tier3"]) => {
	if (!t) return null;
	const out: Record<string, unknown> = {};
	for (const k of [
		"decision",
		"score",
		"refused",
		"reason",
		"errored",
		"overrideApplied",
		"overrideSuppressed",
		"decidedBy",
		"skipReason",
		"note",
	] as const) {
		if (t[k] !== undefined) out[k] = t[k];
	}
	out.hasRaw = "raw" in t && t.raw !== undefined;
	return out;
};

const ADAPTERS: Record<string, (input: FixtureInput) => Promise<unknown>> = {
	// payload → the exact text of every Tier-3 call (tier3_only), plus coverage metadata.
	"tier3-serialize": async (input) => {
		const calls: Array<{ index: number; text: string }> = [];
		const provider: Tier3Provider = {
			classify: async (text, ctx) => {
				calls.push({ index: ctx?.chunk?.index ?? 0, text });
				return { decision: "allow" };
			},
		};
		const r = await createPromptDefense({
			blockHighRisk: true,
			enableTier3: true,
			defenderMode: "tier3_only",
			tier3: { provider, ...input.tier3 },
		}).defendToolResult(input.payload, input.toolName ?? "test_tool");
		return {
			calls: calls.sort((a, b) => a.index - b.index).map((c) => c.text),
			chunkSummary: r.tier3ChunkSummary ?? null,
			coverageDegraded: r.coverageDegraded === true,
			skipReason: r.tier3?.skipReason ?? null,
		};
	},

	// content + context (+ template) → rendered messages; ids in real markers normalized to <ID>.
	"tier3-prompt": async (input) => {
		const prompt = input.prompt as Tier3PromptTemplate | undefined;
		try {
			if (prompt) createLlmTier3Provider({ complete: async () => "", prompt });
			const msgs = buildTier3Messages(prompt ?? DEFAULT_TIER3_PROMPT, input.text, input.ctx);
			const contents = normalizeIds(msgs.map((m) => m.content));
			return { messages: msgs.map((m, i) => ({ role: m.role, content: contents[i] })) };
		} catch {
			return { error: true };
		}
	},

	// model reply → parsed verdict, or error.
	"tier3-parse": async (input) => {
		try {
			return parseVerdictJson(input.reply);
		} catch {
			return { error: true };
		}
	},

	// provider error text → the redacted skipReason defender reports.
	"tier3-redact": async (input) => {
		const r = await createPromptDefense({
			enableTier3: true,
			defenderMode: "tier3_only",
			tier3: { provider: scriptedJudge({ default: { throw: input.message } }) },
		}).defendToolResult({ body: "x" }, "test_tool");
		return { skipReason: r.tier3?.skipReason ?? null };
	},

	// payload + options + scripted judge (+ decide) → the decision.
	"tier3-policy": async (input) => {
		const tier3: NonNullable<PromptDefenseOptions["tier3"]> = { ...input.tier3 };
		const counter = { calls: 0 };
		if (input.judge) tier3.provider = scriptedJudge(input.judge, counter);
		if (input.decide) {
			const d = input.decide as string;
			tier3.decide = () => {
				if (d === "throw") throw new Error("policy bug");
				return d as "allow" | "block" | "default";
			};
		}
		const tier2 = input.tier2 ?? { enabled: false };
		const r = await createPromptDefense({
			blockHighRisk: input.blockHighRisk ?? true,
			enableTier1: input.enableTier1 ?? false,
			enableTier2: tier2.enabled,
			...(tier2.enabled
				? {
						tier2Config: {
							...(tier2.highRiskThreshold !== undefined
								? { highRiskThreshold: tier2.highRiskThreshold }
								: {}),
							...(tier2.mediumRiskThreshold !== undefined
								? { mediumRiskThreshold: tier2.mediumRiskThreshold }
								: {}),
						},
					}
				: {}),
			enableTier3: true,
			defenderMode: input.mode,
			tier3,
		}).defendToolResult(input.payload, input.toolName ?? "test_tool");
		return {
			allowed: r.allowed,
			riskLevel: r.riskLevel,
			tier3: pickTier3(r.tier3),
			coverageDegraded: r.coverageDegraded === true,
			...(r.tier3ChunkSummary ? { chunkSummary: r.tier3ChunkSummary } : {}),
			// How many chunks the judge was actually asked about (stopOnFirstBlock skips the rest).
			...(input.judge ? { judgeCalls: counter.calls } : {}),
		};
	},
};

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

describe("conformance fixtures", () => {
	it("every fixture file has a known area and format version", () => {
		for (const f of files) {
			const fx = JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture;
			expect(Object.keys(ADAPTERS), f).toContain(fx.area);
			expect(fx.version, f).toBe(FORMAT_VERSION);
		}
	});

	// Not expressible as a fixture: marker ids are random per call. A port's runner should check the same.
	it("marker ids are random per call and distinct per block", () => {
		const render = () =>
			buildTier3Messages(DEFAULT_TIER3_PROMPT, "c", { userGoal: "g", toolDescription: "d" })
				.map((m) => m.content)
				.join("\n");
		const idsOf = (text: string) => [...text.matchAll(MARKER_RE)].map((m) => m[2]);
		const a = idsOf(render());
		const b = idsOf(render());
		for (const ids of [a, b]) {
			expect(ids).toHaveLength(6); // 3 blocks × open/close
			expect(new Set(ids).size).toBe(3);
		}
		expect(a.some((id) => b.includes(id))).toBe(false);
	});

	for (const file of files) {
		const path = join(DIR, file);
		const fixture = JSON.parse(readFileSync(path, "utf8")) as Fixture;
		describe(`${file} (${fixture.area})`, () => {
			const seen = new Set<string>();
			for (const c of fixture.cases) {
				it(c.id, async () => {
					expect(seen.has(c.id), `duplicate case id ${c.id}`).toBe(false);
					seen.add(c.id);
					const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
					try {
						const actual = await ADAPTERS[fixture.area](c.input);
						if (UPDATE) c.expect = actual;
						else expect(actual).toEqual(c.expect);
					} finally {
						warn.mockRestore();
					}
				});
			}
			if (UPDATE) {
				it("writes updated expectations", () => {
					writeFileSync(path, `${JSON.stringify(fixture, null, "\t")}\n`);
				});
			}
		});
	}
});
