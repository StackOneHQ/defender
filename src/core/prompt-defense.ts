/**
 * PromptDefense - Main Entry Point
 *
 * The primary class for using the prompt defense framework.
 * Provides a simple API for defending tool results against prompt injection.
 */

import { createPatternDetector, type PatternDetector } from "../classifiers/pattern-detector";
import {
	createTier2Classifier,
	type Tier2Classifier,
	type Tier2ClassifierConfig,
} from "../classifiers/tier2-classifier";
import { createConfig, MAX_TRAVERSAL_DEPTH } from "../config";
import { getDefaultPredictor, type SfePredictor, sfePreprocess } from "../sfe/preprocess";
import type { PromptDefenseConfig, RiskLevel, Tier1Result } from "../types";
import { createToolResultSanitizer, type ToolResultSanitizer } from "./tool-result-sanitizer";

/**
 * Result from defendToolResult() - the primary high-level API.
 *
 * Combines Tier 1 pattern detection and Tier 2 ML classification
 * into a single, easy-to-use result.
 */
export interface DefenseResult {
	/** Whether the tool result should be allowed through to the LLM */
	allowed: boolean;
	/** Overall risk level (max of Tier 1 and Tier 2) */
	riskLevel: RiskLevel;
	/** The sanitized tool result (patterns removed) */
	sanitized: unknown;
	/** All unique pattern detections from Tier 1 */
	detections: string[];
	/** Fields that were sanitized (e.g. ['subject', 'body']) */
	fieldsSanitized: string[];
	/** Which patterns were found in which field (e.g. { subject: ['role_marker'], body: ['instruction_override'] }) */
	patternsByField: Record<string, string[]>;
	/**
	 * Tier 2 score reported to operators. Designed so the triple
	 * (`tier2Score`, `riskLevel`, `allowed`) tells one coherent story:
	 *
	 *   - Single-head: post-density max-chunk main score. Compared against
	 *     `tier2.highRiskThreshold` to set `riskLevel`. When `blockHighRisk`
	 *     is enabled and no Tier 1 detection independently forces a block,
	 *     `tier2Score >= highRiskThreshold` ⇔ `result.allowed === false`.
	 *     (Tier 1 detections can still drive `allowed: false` while Tier 2 is
	 *     below threshold; `blockHighRisk: false` keeps `allowed: true`
	 *     regardless.)
	 *   - Multi-head rule fired: main score of the chunk that triggered the
	 *     rule. `riskLevel: "high"`, `allowed: false`.
	 *   - Multi-head aux veto: 0. The rule rescued the content, so Tier 2
	 *     contributes nothing to a block. `riskLevel: "low"`, `allowed: true`.
	 *     The model's actual main signal is preserved on `tier2RawScore`.
	 *
	 * Undefined when Tier 2 is disabled or no strings were scored.
	 */
	tier2Score?: number;
	/**
	 * Raw max-chunk main score before density adjustment. Diverges from
	 * `tier2Score` only on multi-string payloads where the density damping
	 * factor < 1. Useful for forensics / threshold tuning; do not use as a
	 * primary block signal — it does NOT match the decision under density.
	 */
	tier2RawScore?: number;
	/**
	 * Tier 2 auxiliary head score (multi-head models only), reported for the
	 * chunk that produced `tier2Score`. High aux + `multihead` config → veto.
	 */
	tier2AuxScore?: number;
	/**
	 * True when the multi-head decision rule (main >= mainThr AND aux < auxThr)
	 * fired on at least one chunk. Surfaced so callers can distinguish
	 * "blocked because main is high" from "blocked under the multi-head rule".
	 */
	tier2MultiheadBlocked?: boolean;
	/** Reason Tier 2 was skipped (e.g. "No strings extracted") when tier2Score is undefined */
	tier2SkipReason?: string;
	/** The sentence with the highest Tier 2 score */
	maxSentence?: string;
	/**
	 * Field paths excluded from Tier 2 classification by the SFE preprocessor.
	 * These fields are still present in `sanitized` (the returned payload is
	 * the full original value — SFE filtering is classifier-only).
	 * Empty array when `useSfe` is disabled (the default).
	 */
	fieldsDropped: string[];
	/**
	 * True if any recursive payload walk hit `MAX_TRAVERSAL_DEPTH` —
	 * analysis is complete only to that depth, deeper fields passed through
	 * unchanged. Stack-safety guard; typically never set on real payloads.
	 */
	truncatedAtDepth?: boolean;
	/** Total processing time in milliseconds */
	latencyMs: number;
}

/**
 * Recursively extract all string values from an object.
 * When `fields` is provided, only strings under matching field keys are collected;
 * the traversal still descends into non-matching keys to find matching ones deeper.
 */
function extractStrings(obj: unknown, fields: string[] | undefined, depthFlag: { hit: boolean }): string[] {
	const strings: string[] = [];

	function collectAll(value: unknown, depth: number): void {
		if (depth > MAX_TRAVERSAL_DEPTH) {
			depthFlag.hit = true;
			return;
		}
		if (typeof value === "string") {
			strings.push(value);
		} else if (Array.isArray(value)) {
			for (const item of value) collectAll(item, depth + 1);
		} else if (value && typeof value === "object") {
			for (const v of Object.values(value)) collectAll(v, depth + 1);
		}
	}

	if (!fields || fields.length === 0) {
		collectAll(obj, 0);
		return strings;
	}

	// Handle bare string input — no keys to match against, collect it directly
	if (typeof obj === "string") {
		strings.push(obj);
		return strings;
	}

	// Use a Set for O(1) key lookups during traversal
	const fieldSet = new Set(fields);

	function traverse(value: unknown, depth: number): void {
		if (depth > MAX_TRAVERSAL_DEPTH) {
			depthFlag.hit = true;
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) traverse(item, depth + 1);
		} else if (value && typeof value === "object") {
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (fieldSet.has(k)) {
					collectAll(v, depth + 1);
				} else {
					traverse(v, depth + 1);
				}
			}
		}
		// Strings under non-matching keys are intentionally skipped —
		// only strings under matching field names are collected.
	}

	traverse(obj, 0);
	return strings;
}

/**
 * Options for PromptDefense initialization
 */
export interface PromptDefenseOptions {
	/** Full configuration override */
	config?: Partial<PromptDefenseConfig>;
	/** Enable Tier 1 classification */
	enableTier1?: boolean;
	/** Enable Tier 2 ML classification (default: true — set false to disable) */
	enableTier2?: boolean;
	/** Tier 2 classifier configuration */
	tier2Config?: Partial<Tier2ClassifierConfig>;
	/** Block high/critical risk content */
	blockHighRisk?: boolean;
	/** Default risk level for unclassified content */
	defaultRiskLevel?: RiskLevel;
	/**
	 * Wrap sanitized string fields with `[UD-<id>]...[/UD-<id>]` boundary
	 * markers so downstream LLM prompts can distinguish untrusted data.
	 * Default: false. Opt-in — when off, boundary generation is skipped
	 * entirely (no `generateDataBoundary()` call per tool result).
	 *
	 * When enabled, pair with `generateBoundaryInstructions()` (exported from
	 * `@stackone/defender`) to add the matching system-prompt instructions.
	 */
	annotateBoundary?: boolean;
	/**
	 * Only run Tier 2 on strings extracted from these field names.
	 * Strings under any other field key are skipped.
	 * If omitted, Tier 2 runs on all strings in the tool result.
	 */
	tier2Fields?: string[];
	/**
	 * Enable the Semantic Field Extractor (SFE) preprocessor.
	 *
	 * When `true`, the tool-result payload is passed through a bundled
	 * quantized FastText classifier before Tier 2. Fields the model classifies
	 * as metadata/identifiers are excluded from Tier 2 string extraction;
	 * user-facing content (name/description/body/etc.) passes through.
	 * The returned `DefenseResult.sanitized` always contains the full original
	 * payload — SFE filtering is classifier-only and does not drop data.
	 *
	 * Measured impact across 22,307 benign payloads (4 datasets):
	 *   - StackOne connector FPR:  0.96% → 0.53% (44% reduction)
	 *   - ToolACE FPR:             0.95% → 0.88%
	 *   - ChatML FPR:              0.13% → 0.10%
	 *   - MirrorAPI FPR:           unchanged (content-level model errors)
	 *   - Defender latency:        ≈15 ms → ≈13 ms (smaller payloads)
	 *
	 * Zero false drops introduced on any benchmark.
	 *
	 * Requires `fasttext.wasm` to be installed (optional peer dependency).
	 * If the runtime is unavailable at initialization time, the preprocessor
	 * fails open — payloads pass through unfiltered with a single
	 * console.warn.
	 *
	 * Default: false. Pass `{ threshold: 0.3 }` to override the drop
	 * threshold (default 0.5 — tuned for zero false drops). Pass
	 * `{ predictor: customPredictor }` to substitute a caller-supplied
	 * FastText-compatible predictor.
	 */
	useSfe?: boolean | { threshold?: number; predictor?: SfePredictor };
}

/**
 * PromptDefense - Main API for prompt injection defense
 *
 * @example
 * ```typescript
 * import { createPromptDefense } from '@stackone/defender';
 *
 * const defense = createPromptDefense();
 * await defense.warmupTier2();
 *
 * const result = await defense.defendToolResult(toolOutput, 'gmail_get_message');
 * if (!result.allowed) {
 *   console.log(`Blocked: ${result.riskLevel}`);
 * }
 * ```
 */
export class PromptDefense {
	private config: PromptDefenseConfig;
	private toolResultSanitizer: ToolResultSanitizer;
	private patternDetector: PatternDetector;
	private tier2Classifier: Tier2Classifier | null = null;
	private tier2Fields: string[] | undefined;
	private sfeEnabled: boolean = false;
	private sfeThreshold: number = 0.5;
	private sfeCustomPredictor: SfePredictor | undefined = undefined;

	constructor(options: PromptDefenseOptions = {}) {
		// Build configuration
		this.config = createConfig(options.config ?? {});

		// Override specific options
		if (options.blockHighRisk !== undefined) {
			this.config.blockHighRisk = options.blockHighRisk;
		}

		this.tier2Fields = options.tier2Fields ?? this.config.tier2?.tier2Fields;

		// SFE preprocessor — off by default. When `true`, enable with the
		// bundled quantized FastText model. When an object is passed, enable
		// with its threshold and/or a custom predictor.
		if (options.useSfe === true) {
			this.sfeEnabled = true;
		} else if (options.useSfe && typeof options.useSfe === "object") {
			this.sfeEnabled = true;
			if (typeof options.useSfe.threshold === "number") this.sfeThreshold = options.useSfe.threshold;
			if (options.useSfe.predictor) this.sfeCustomPredictor = options.useSfe.predictor;
		}

		// Initialize components
		this.toolResultSanitizer = createToolResultSanitizer({
			riskyFields: this.config.riskyFields,
			traversal: this.config.traversal,
			defaultRiskLevel: options.defaultRiskLevel ?? "medium",
			useTier1Classification: options.enableTier1 ?? true,
			blockHighRisk: options.blockHighRisk ?? false,
			annotateBoundary: options.annotateBoundary ?? false,
			cumulativeRiskThresholds: this.config.cumulativeRiskThresholds,
		});

		this.patternDetector = createPatternDetector();

		// Initialize Tier 2 classifier if enabled
		if (options.enableTier2 ?? true) {
			this.tier2Classifier = createTier2Classifier(options.tier2Config);
			// Sync the gate's threshold copy with whatever Tier2Classifier resolved.
			// Tier2Classifier merges hardcoded defaults < model classifier_config.json
			// < caller-provided `tier2Config`; reading back here ensures the gate at
			// `this.config.tier2.highRiskThreshold` (line ~615) matches the
			// `getRiskLevel` thresholds used inside Tier 2. Without this readback,
			// a model that ships calibrated defaults (e.g. v5 with highRiskThreshold
			// = 0.64) lands `riskLevel: "high"` at score 0.7 but `allowed: true`
			// because the gate is still on the library default of 0.8.
			if (this.config.tier2) {
				const effective = this.tier2Classifier.getConfig();
				this.config.tier2.highRiskThreshold = effective.highRiskThreshold;
				this.config.tier2.mediumRiskThreshold = effective.mediumRiskThreshold;
			}
		}
	}

	/**
	 * Pre-load the Tier 2 ONNX model and tokenizer
	 *
	 * Call this at startup to avoid latency on first classification.
	 * Loads the bundled ONNX model and tokenizer into memory; no downloads are performed.
	 */
	async warmupTier2(): Promise<void> {
		if (this.tier2Classifier) {
			await this.tier2Classifier.warmup();
		}
		// Also warm the SFE predictor (bundled FastText WASM) if enabled.
		// Idempotent — subsequent calls reuse the cached predictor. Fail
		// open on any error (model missing, WASM init failure) — the
		// preprocessor path already handles a null predictor by passing
		// payloads through unfiltered, so a warmup failure must not
		// propagate to callers and break their startup.
		if (this.sfeEnabled && !this.sfeCustomPredictor) {
			// getDefaultPredictor() already catches load failures internally
			// and resolves to null — it never rejects. So we check the
			// resolved value instead of wrapping in try/catch. A null here
			// means the preprocessor will pass payloads through unfiltered
			// at call time; `this.sfeEnabled` stays true so a later retry
			// (e.g. after the missing dep is installed) is still possible.
			const predictor = await getDefaultPredictor();
			if (!predictor) {
				console.warn(
					"[defender] SFE predictor unavailable at warmup; calls with useSfe enabled will pass payloads through unfiltered until the runtime or model file is available.",
				);
			}
		}
	}

	/**
	 * Check if Tier 2 is ready (weights loaded and classifier available)
	 */
	isTier2Ready(): boolean {
		return this.tier2Classifier?.isReady() ?? false;
	}

	/**
	 * Defend a tool result using both Tier 1 and Tier 2 classification.
	 *
	 * This is the primary method. It:
	 * 1. Runs Tier 1 pattern detection (sanitization)
	 * 2. Runs Tier 2 sentence-level ML classification (if enabled)
	 * 3. Combines risk levels and returns a simple allow/block decision
	 *
	 * @param value - The tool result to defend
	 * @param toolName - Name of the tool that produced this result
	 * @returns DefenseResult with allowed, riskLevel, detections, and tier2Score
	 */
	async defendToolResult(value: unknown, toolName: string): Promise<DefenseResult> {
		const startTime = performance.now();

		// Shared stack-safety flag — flipped by any walk that hits
		// MAX_TRAVERSAL_DEPTH. Surfaced in DefenseResult.truncatedAtDepth.
		const depthFlag = { hit: false };

		// SFE preprocessor — narrows what reaches the Tier 2 classifier by
		// dropping metadata/identifier leaf fields via the bundled quantized
		// FastText model. The filtered payload is used ONLY for Tier 2 string
		// extraction; Tier 1 sanitization and the returned output always
		// operate on the original value so no data is lost downstream.
		let sfeFilteredValue: unknown = value;
		let fieldsDropped: string[] = [];
		if (this.sfeEnabled) {
			try {
				const predictor = this.sfeCustomPredictor ?? (await getDefaultPredictor());
				if (predictor) {
					const pre = await sfePreprocess(value, {
						predictor,
						threshold: this.sfeThreshold,
					});
					sfeFilteredValue = pre.filtered;
					fieldsDropped = pre.dropped;
					if (pre.truncatedAtDepth) depthFlag.hit = true;
				}
			} catch (err) {
				// Fail open — continue with the unfiltered value so defense
				// never breaks on a preprocessor failure. Log so operators
				// can detect predictor regressions (e.g. WASM runtime
				// transient failures, malformed payload) via telemetry.
				console.warn(
					`[defender] SFE preprocessing failed; continuing without filtering. Reason: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Tier 1: pattern-based sanitization on the original value — SFE
		// filtering is classifier-only and must not affect the returned payload.
		const sanitized = this.toolResultSanitizer.sanitize(value, { toolName });

		// Collect Tier 1 metadata
		const { patternsRemovedByField, methodsByField } = sanitized.metadata;
		const detections = [...new Set(Object.values(patternsRemovedByField).flat())];
		// Fields where threat-related sanitization occurred
		const activeMethods = new Set(["role_stripping", "pattern_removal", "encoding_detection"]);
		const fieldsSanitized = Object.entries(methodsByField)
			.filter(([, methods]) => methods.some((m) => activeMethods.has(m)))
			.map(([field]) => field);

		// Tier 2: packed-chunk ML classification on the SFE-filtered value so
		// metadata/identifier fields don't inflate injection scores.
		//
		// Three score variables track different stages of the same signal:
		//   - tier2Score: local intermediate. Starts as max-chunk main, gets
		//     reassigned to the rule-trigger chunk's main under multi-head
		//     rule fire. NOT surfaced directly on the result.
		//   - tier2RawScore: max-chunk main pre-density, pre-rule-reassignment.
		//     Surfaced as `result.tier2RawScore` for forensics.
		//   - tier2EffectiveScore: the score that drives the block decision.
		//     Under single-head this is post-density `tier2Score`. Under
		//     multi-head rule fire this is the rule-trigger chunk's main.
		//     Surfaced as `result.tier2Score`.
		let tier2Score: number | undefined;
		let tier2RawScore: number | undefined;
		let tier2AuxScore: number | undefined;
		let tier2MultiheadBlocked: boolean | undefined;
		let tier2EffectiveScore: number | undefined;
		let tier2SkipReason: string | undefined;
		let maxSentence: string | undefined;
		let tier2Risk: RiskLevel = "low";

		if (this.tier2Classifier) {
			// Use explicit tier2Fields if provided; otherwise scan all strings.
			// Restricting to Tier 1 riskyFieldNames would create a coverage gap: injections
			// in fields not covered by tool rules would bypass Tier 2 entirely while still
			// being visible to the LLM. Scanning all strings is the safe default.
			const fieldsForTier2 = this.tier2Fields;
			const strings = extractStrings(sfeFilteredValue, fieldsForTier2, depthFlag).filter((s) => s.length > 0);

			if (strings.length > 0) {
				// Per-string classification with BATCHED inference.
				//
				// Why per-string: keeps a benign metadata blob in one field from
				// diluting a real injection in another. Measured A/B on 940 benign
				// connector payloads: join-text-style aggregation gives 63/940 FPs
				// (6.70%) vs per-string 2-3/940 (0.21-0.32%) — 10× worse FPR.
				//
				// Why batched: v0.6.0's per-string loop ran one ONNX inference per
				// string serially, which on list-response payloads (~1000 fields)
				// was ~80 ms with SFE vs ~7 ms for join-text. We now prepare all
				// chunks up-front and run a single classifyChunksBatch() — ~10×
				// throughput recovery while keeping per-string scoring semantics.

				// Capture a non-null local so the map callback below doesn't lose
				// the narrowing from the surrounding `if (this.tier2Classifier)`.
				const tier2 = this.tier2Classifier;

				// Phase 1: compute chunks per string (warmup + tokenize + pack),
				// track where each string's chunks live in the flat chunk array.
				const preps = await Promise.all(strings.map((s) => tier2.prepareChunks(s)));
				const allChunks: string[] = [];
				const stringRanges: Array<{ start: number; end: number }> = [];
				const skipReasons = new Set<string>();
				for (const prep of preps) {
					if (prep.skipped) {
						if (prep.skipReason) skipReasons.add(prep.skipReason);
						stringRanges.push({ start: -1, end: -1 });
						continue;
					}
					stringRanges.push({ start: allChunks.length, end: allChunks.length + prep.chunks.length });
					allChunks.push(...prep.chunks);
				}

				if (allChunks.length === 0) {
					const reasons = Array.from(skipReasons);
					tier2SkipReason =
						reasons.length === 0
							? "All strings skipped by classifier"
							: `All strings skipped by classifier: ${reasons.join("; ")}`;
				} else {
					// Phase 2: ONE batched ONNX call for every chunk across every string.
					// Fail-safe: inference errors mark Tier 2 as skipped rather than
					// propagating out of defendToolResult (matches the old
					// classifyByChunks contract).
					const multiheadCfg = this.tier2Classifier.getMultiheadConfig();
					let allScores: number[] | null = null;
					let allPairs: Array<{ main: number; aux: number | null }> | null = null;
					try {
						if (multiheadCfg) {
							allPairs = await this.tier2Classifier.classifyChunksBatchPair(allChunks);
							// Single-head model under a multi-head config: every aux is null.
							// Without this guard the rule path sees no aux signal, treats no
							// chunk as a multihead block, fires the aux-veto branch, and
							// collapses tier2EffectiveScore to 0 — Tier 2 is silently
							// disabled. Surface the misconfig instead.
							if (allPairs.length > 0 && allPairs.every((p) => p.aux === null)) {
								tier2SkipReason =
									"multihead configured but model emits single-head logits — remove `multihead` config or use a dual-head model";
								allPairs = null;
							} else {
								allScores = allPairs.map((p) => p.main);
							}
						} else {
							allScores = await this.tier2Classifier.classifyChunksBatch(allChunks);
						}
					} catch (err) {
						tier2SkipReason = `Inference error: ${err instanceof Error ? err.message : String(err)}`;
					}

					if (allScores) {
						// Phase 3: compute per-string max; track global max + chunk.
						const perStringScores: number[] = [];
						// Multi-head: track whether any chunk independently triggers
						// the (main >= mainThr AND aux < auxThr) rule, and remember
						// the strongest such chunk so the result surfaces it.
						let mhAnyBlock = false;
						let mhTopBlockChunk = "";
						let mhTopBlockMain = -1;
						let mhTopBlockAux: number | undefined;
						// Aux score of the chunk with the global-max main score. Only
						// populated under multi-head config (`allPairs` is null in
						// single-head mode); used by the aux-veto branch below so the
						// reported `tier2AuxScore` points at the chunk that came
						// closest to blocking.
						let auxOfMaxMain: number | undefined;
						for (let i = 0; i < strings.length; i++) {
							const { start, end } = stringRanges[i];
							if (start < 0) continue;
							let sMax = 0;
							let sMaxChunk = "";
							let sMaxAux: number | undefined;
							for (let j = start; j < end; j++) {
								const raw = allScores[j];
								const safeScore = Number.isFinite(raw) ? raw : 0;
								if (safeScore > sMax) {
									sMax = safeScore;
									sMaxChunk = allChunks[j] ?? "";
									if (allPairs) {
										const auxRaw = allPairs[j]?.aux;
										sMaxAux = auxRaw === null || auxRaw === undefined ? undefined : auxRaw;
									}
								}
								if (multiheadCfg && allPairs) {
									const auxRaw = allPairs[j]?.aux;
									if (auxRaw !== null && auxRaw !== undefined) {
										const chunkBlocks =
											safeScore >= multiheadCfg.mainThreshold &&
											auxRaw < multiheadCfg.auxThreshold;
										if (chunkBlocks) {
											mhAnyBlock = true;
											if (safeScore > mhTopBlockMain) {
												mhTopBlockMain = safeScore;
												mhTopBlockAux = auxRaw;
												mhTopBlockChunk = allChunks[j] ?? "";
											}
										}
									}
								}
							}
							perStringScores.push(sMax);
							if (tier2Score === undefined || sMax > tier2Score) {
								tier2Score = sMax;
								maxSentence = sMaxChunk;
								auxOfMaxMain = sMaxAux;
							}
						}

						// Capture the raw max-chunk main score before any density adjustment
						// or multi-head rule reassignment. Surfaced as `tier2RawScore` on the
						// result for forensics / threshold tuning. Decision-relevant scoring
						// is in `tier2EffectiveScore`.
						tier2RawScore = tier2Score;

						if (multiheadCfg && allPairs) {
							// Multi-head decision rule: report the rule-triggering chunk
							// when the rule fires, otherwise report the (rescued) global
							// max-main chunk for debugging. Density damping is intentionally
							// not applied here — the rule's chunk-level main scores are
							// already the decision signal.
							tier2MultiheadBlocked = mhAnyBlock;
							if (mhAnyBlock) {
								tier2Risk = "high";
								maxSentence = mhTopBlockChunk;
								tier2Score = mhTopBlockMain;
								tier2EffectiveScore = mhTopBlockMain;
								tier2AuxScore = mhTopBlockAux;
							} else {
								// Aux veto fired — the rule rescued this content, so Tier 2
								// contributed nothing to a block. Set `tier2EffectiveScore = 0`
								// so the operator triple (`tier2Score`, `riskLevel`, `allowed`)
								// reads coherently as zero / low / true. The model's actual
								// main signal is on `tier2RawScore`; the aux that did the
								// rescuing is reported via `tier2AuxScore`.
								tier2Risk = "low";
								tier2EffectiveScore = 0;
								tier2AuxScore = auxOfMaxMain;
							}
						} else if (tier2Score !== undefined) {
							// Single-head path: cross-string density adjustment (mild),
							// then bucket into risk level via the configured thresholds.
							//
							// Density damping fires only on 3+ strings — a 1- or 2-string
							// payload is mathematically indistinguishable from a real
							// attack that happens to be short, and damping would create
							// false negatives. For larger payloads, a lone high-scoring
							// string surrounded by many benign strings is typical of
							// benign connector responses (e.g. 100 pay schedules with one
							// imperative descriptor). The factor `pow(highCount/total, 0.1)`
							// is gentle: 1/100 → 0.63×, 1/10 → 0.79×, 5/10 → 0.93×.
							//
							// The "high" cutoff was originally hardcoded at 0.75 (raw sigmoid
							// space). Under temperatureT > 1 every score is
							// `sigmoid(logit / T)` — compressed toward 0.5 — so a literal
							// 0.75 cutoff stops counting events that were "high" under raw
							// scoring. Rescale in logit-space: raw 0.75 corresponds to logit
							// log(3) ≈ 1.0986; calibrated cutoff is sigmoid(log(3)/T). At
							// T=1 this is 0.75 (no-op); at T=2.41 it's ≈ 0.612.
							tier2EffectiveScore = tier2Score;
							const T = this.tier2Classifier.getTemperature() ?? 1;
							const DENSITY_SUB_THRESHOLD = T === 1 ? 0.75 : 1 / (1 + Math.exp(-Math.log(3) / T));
							if (perStringScores.length > 2) {
								const highCount = perStringScores.filter((s) => s >= DENSITY_SUB_THRESHOLD).length;
								if (highCount > 0) {
									const factor = (highCount / perStringScores.length) ** 0.1;
									tier2EffectiveScore = tier2Score * factor;
								}
							}
							tier2Risk = this.tier2Classifier.getRiskLevel(tier2EffectiveScore);
						}
					}
				}
			} else {
				tier2SkipReason = this.tier2Fields?.length
					? "No strings found in tier2Fields"
					: "No strings extracted from tool result";
			}
		}

		// Combine risk levels (take the higher of Tier 1 and Tier 2)
		const riskLevels: RiskLevel[] = ["low", "medium", "high", "critical"];
		const tier1Index = riskLevels.indexOf(sanitized.metadata.overallRiskLevel);
		const tier2Index = riskLevels.indexOf(tier2Risk);
		const riskLevel = riskLevels[Math.max(tier1Index, tier2Index)];

		// Determine whether any threat signals were found (Tier 1 or Tier 2).
		// fieldsSanitized captures sanitization methods (role stripping, encoding detection, etc.)
		// that may fire without adding named pattern detections, so we include it here.
		// In multi-head mode the rule replaces the threshold check: a flagged
		// chunk under (main >= mainThr AND aux < auxThr) is a Tier 2 threat;
		// aux veto suppresses the threshold-based Tier 2 signal entirely.
		const tier2HasThreat = tier2MultiheadBlocked
			? true
			: tier2MultiheadBlocked === false
				? false
				: tier2EffectiveScore !== undefined && tier2EffectiveScore >= this.config.tier2.highRiskThreshold;
		const hasThreats = detections.length > 0 || fieldsSanitized.length > 0 || tier2HasThreat;

		// Three cases for allowed:
		// 1. blockHighRisk is off → always allow
		// 2. No threat signals found → allow (base risk from tool rules alone does not block)
		// 3. Risk did not reach high/critical → allow
		const allowed = !this.config.blockHighRisk || !hasThreats || (riskLevel !== "high" && riskLevel !== "critical");

		// `tier2Score` reports `tier2EffectiveScore` — the value that drove the
		// block decision. When `blockHighRisk` is on and no Tier 1 detection
		// independently forces a block:
		//   `tier2Score >= highRiskThreshold` ⇔ `allowed === false`
		// The multi-head aux veto path sets `tier2EffectiveScore = 0` (not
		// undefined), keeping the triple coherent: tier2Score=0 / riskLevel
		// low / allowed=true. `tier2RawScore` is the pre-density / pre-rule
		// max-chunk main score for forensics — never use it to make decisions;
		// it diverges from `tier2Score` on multi-string payloads and under
		// multi-head aux veto.
		return {
			allowed,
			riskLevel,
			sanitized: sanitized.sanitized,
			detections,
			fieldsSanitized,
			patternsByField: patternsRemovedByField,
			tier2Score: tier2EffectiveScore,
			tier2RawScore,
			tier2AuxScore,
			tier2MultiheadBlocked,
			tier2SkipReason,
			maxSentence,
			fieldsDropped,
			truncatedAtDepth: depthFlag.hit || undefined,
			latencyMs: performance.now() - startTime,
		};
	}

	/**
	 * Defend multiple tool results in batch.
	 *
	 * Runs Tier 1 synchronously per result, then Tier 2 concurrently across all results.
	 *
	 * @param items - Array of { value, toolName } pairs to defend
	 * @returns Array of DefenseResults in the same order as input
	 */
	async defendToolResults(items: Array<{ value: unknown; toolName: string }>): Promise<DefenseResult[]> {
		return Promise.all(items.map(({ value, toolName }) => this.defendToolResult(value, toolName)));
	}

	/**
	 * Analyze text for potential injection threats (Tier 1 only)
	 *
	 * Uses pattern detection to identify suspicious content.
	 * For full defense including Tier 2 ML, use defendToolResult() instead.
	 *
	 * @param text - Text to analyze
	 * @returns Classification result with risk level and matches
	 */
	analyze(text: string): Tier1Result {
		return this.patternDetector.analyze(text);
	}

	/**
	 * Get the current configuration
	 */
	getConfig(): PromptDefenseConfig {
		return { ...this.config };
	}
}

/**
 * Create a PromptDefense instance
 */
export function createPromptDefense(options?: PromptDefenseOptions): PromptDefense {
	return new PromptDefense(options);
}
