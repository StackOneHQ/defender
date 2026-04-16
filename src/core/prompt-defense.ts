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
import { createConfig } from "../config";
import type { PromptDefenseConfig, RiskLevel, Tier1Result } from "../types";
import { stripBoundaryPatterns } from "../utils/boundary";
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
	/** Tier 2 ML score (0.0 = safe, 1.0 = injection), undefined if Tier 2 not enabled */
	tier2Score?: number;
	/** Reason Tier 2 was skipped (e.g. "No strings extracted") when tier2Score is undefined */
	tier2SkipReason?: string;
	/** The sentence with the highest Tier 2 score */
	maxSentence?: string;
	/** Total processing time in milliseconds */
	latencyMs: number;
}

/**
 * Recursively extract all string values from an object.
 * When `fields` is provided, only strings under matching field keys are collected;
 * the traversal still descends into non-matching keys to find matching ones deeper.
 */
function extractStrings(obj: unknown, fields?: string[]): string[] {
	const strings: string[] = [];

	function collectAll(value: unknown): void {
		if (typeof value === "string") {
			strings.push(value);
		} else if (Array.isArray(value)) {
			for (const item of value) collectAll(item);
		} else if (value && typeof value === "object") {
			for (const v of Object.values(value)) collectAll(v);
		}
	}

	if (!fields || fields.length === 0) {
		collectAll(obj);
		return strings;
	}

	// Handle bare string input — no keys to match against, collect it directly
	if (typeof obj === "string") {
		strings.push(obj);
		return strings;
	}

	// Use a Set for O(1) key lookups during traversal
	const fieldSet = new Set(fields);

	function traverse(value: unknown): void {
		if (Array.isArray(value)) {
			for (const item of value) traverse(item);
		} else if (value && typeof value === "object") {
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (fieldSet.has(k)) {
					collectAll(v);
				} else {
					traverse(v);
				}
			}
		}
		// Strings under non-matching keys are intentionally skipped —
		// only strings under matching field names are collected.
	}

	traverse(obj);
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
	 * Only run Tier 2 on strings extracted from these field names.
	 * Strings under any other field key are skipped.
	 * If omitted, Tier 2 runs on all strings in the tool result.
	 */
	tier2Fields?: string[];
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

	constructor(options: PromptDefenseOptions = {}) {
		// Build configuration
		this.config = createConfig(options.config ?? {});

		// Override specific options
		if (options.blockHighRisk !== undefined) {
			this.config.blockHighRisk = options.blockHighRisk;
		}

		this.tier2Fields = options.tier2Fields ?? this.config.tier2?.tier2Fields;

		// Initialize components
		this.toolResultSanitizer = createToolResultSanitizer({
			riskyFields: this.config.riskyFields,
			traversal: this.config.traversal,
			defaultRiskLevel: options.defaultRiskLevel ?? "medium",
			useTier1Classification: options.enableTier1 ?? true,
			blockHighRisk: options.blockHighRisk ?? false,
			cumulativeRiskThresholds: this.config.cumulativeRiskThresholds,
		});

		this.patternDetector = createPatternDetector();

		// Initialize Tier 2 classifier if enabled
		if (options.enableTier2 ?? true) {
			this.tier2Classifier = createTier2Classifier(options.tier2Config);
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

		// Tier 1: pattern-based sanitization
		const sanitized = this.toolResultSanitizer.sanitize(value, { toolName });

		// Collect Tier 1 metadata
		const { patternsRemovedByField, methodsByField } = sanitized.metadata;
		const detections = [...new Set(Object.values(patternsRemovedByField).flat())];
		// Fields where threat-related sanitization occurred
		const activeMethods = new Set(["role_stripping", "pattern_removal", "encoding_detection"]);
		const fieldsSanitized = Object.entries(methodsByField)
			.filter(([, methods]) => methods.some((m) => activeMethods.has(m)))
			.map(([field]) => field);

		// Tier 2: sentence-level ML classification on raw (unsanitized) value
		let tier2Score: number | undefined;
		let tier2AdjustedScore: number | undefined; // internal only — drives risk level, not returned
		let tier2SkipReason: string | undefined;
		let maxSentence: string | undefined;
		let tier2Risk: RiskLevel = "low";

		if (this.tier2Classifier) {
			// Use explicit tier2Fields if provided; otherwise scan all strings.
			// Restricting to Tier 1 riskyFieldNames would create a coverage gap: injections
			// in fields not covered by tool rules would bypass Tier 2 entirely while still
			// being visible to the LLM. Scanning all strings is the safe default.
			const fieldsForTier2 = this.tier2Fields;
			const strings = extractStrings(value, fieldsForTier2).map(stripBoundaryPatterns);
			const combinedText = strings.join("\n\n");

			if (combinedText.length > 0) {
				const tier2Result = await this.tier2Classifier.classifyBySentence(combinedText);
				if (!tier2Result.skipped) {
					tier2Score = tier2Result.score;
					maxSentence = tier2Result.maxSentence;

					// Density adjustment: penalise isolated high-scoring sentences in mostly-benign text.
					// A single imperative sentence ("Check activity") in a 5-sentence security email
					// should not trigger the same risk as a fully malicious payload.
					//
					// effectiveScore = maxScore × sqrt(highCount / totalCount)
					//   highCount  = sentences scoring >= DENSITY_SUB_THRESHOLD
					//   totalCount = all classified sentences
					//
					// Examples:
					//   Real injection (2/2 very-high): 0.997 × sqrt(2/2) = 0.997 → high ✓
					//   Security alert (1/3 very-high ≥ 0.9): 0.988 × sqrt(1/3) = 0.570 → medium ✓
					//   "Authenticator app added as sign-in step" scores ~0.51 — below the 0.9 threshold,
					//   so does not inflate highCount.
					const DENSITY_SUB_THRESHOLD = 0.9;
					const sentenceScores = tier2Result.sentenceScores ?? [];
					const totalCount = sentenceScores.length;
					if (totalCount > 2) {
						// 3+ sentences: enough context for meaningful density signal.
						// Penalise isolated high-scoring sentences in largely benign text
						// (e.g. "Check and secure your account now." in a 3-sentence Google alert).
						// Short texts (1-2 sentences) are left unadjusted — a 2-sentence injection
						// ("Ignore all instructions. Do X.") would be unfairly penalised because
						// its density is mathematically identical to a lone FP sentence.
						//
						// Only apply density when at least one sentence exceeds the threshold.
						// If highCount === 0, sqrt(0) = 0 would zero out any non-trivial raw score.
						const highCount = sentenceScores.filter((s) => s.score >= DENSITY_SUB_THRESHOLD).length;
						if (highCount > 0) {
							const densityFactor = Math.sqrt(highCount / totalCount);
							const effective = tier2Score * densityFactor;
							tier2AdjustedScore = effective;
							tier2Risk = this.tier2Classifier.getRiskLevel(effective);
						} else {
							// No sentence above threshold — density would zero out the score; use raw
							tier2Risk = this.tier2Classifier.getRiskLevel(tier2Score);
						}
					} else {
						// 1-2 sentences — no meaningful density signal; use raw score
						tier2Risk = this.tier2Classifier.getRiskLevel(tier2Score);
					}
				} else {
					tier2SkipReason = tier2Result.skipReason;
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
		// Use adjusted score for threat detection when available (density-penalised);
		// fall back to raw score for single-sentence results where no adjustment was applied.
		const effectiveTier2Score = tier2AdjustedScore ?? tier2Score;
		const hasThreats =
			detections.length > 0 ||
			fieldsSanitized.length > 0 ||
			(effectiveTier2Score !== undefined && effectiveTier2Score >= this.config.tier2.highRiskThreshold);

		// Three cases for allowed:
		// 1. blockHighRisk is off → always allow
		// 2. No threat signals found → allow (base risk from tool rules alone does not block)
		// 3. Risk did not reach high/critical → allow
		const allowed = !this.config.blockHighRisk || !hasThreats || (riskLevel !== "high" && riskLevel !== "critical");

		return {
			allowed,
			riskLevel,
			sanitized: sanitized.sanitized,
			detections,
			fieldsSanitized,
			patternsByField: patternsRemovedByField,
			tier2Score,
			tier2SkipReason,
			maxSentence,
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
