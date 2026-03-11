/**
 * PromptDefense - Main Entry Point
 *
 * The primary class for using the prompt defense framework.
 * Provides a simple API for defending tool results against prompt injection.
 */

import type { MLPWeights } from "../classifiers/mlp";
import { createPatternDetector, type PatternDetector } from "../classifiers/pattern-detector";
import {
	createTier2Classifier,
	type Tier2Classifier,
	type Tier2ClassifierConfig,
} from "../classifiers/tier2-classifier";
import { createConfig } from "../config";
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
	/** Tier 2 ML score (0.0 = safe, 1.0 = injection), undefined if Tier 2 not enabled */
	tier2Score?: number;
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

	function traverse(value: unknown): void {
		if (Array.isArray(value)) {
			for (const item of value) traverse(item);
		} else if (value && typeof value === "object") {
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (fields?.includes(k)) {
					collectAll(v);
				} else {
					traverse(v);
				}
			}
		}
	}

	if (!fields) {
		collectAll(obj);
	} else {
		traverse(obj);
	}

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
	/** MLP weights for Tier 2 (load at construction or later via loadTier2Weights) */
	tier2Weights?: MLPWeights;
	/** Block high/critical risk content */
	blockHighRisk?: boolean;
	/** Default risk level for unclassified content */
	defaultRiskLevel?: RiskLevel;
	/**
	 * Use built-in per-tool sanitization rules (e.g. gmail_* defaults to high risk).
	 * Defaults to false — tool rules are opt-in to avoid unexpected risk level inflation.
	 */
	useDefaultToolRules?: boolean;
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
 * const defense = createPromptDefense({ enableTier2: true });
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

		this.tier2Fields = options.tier2Fields;

		// Initialize components
		this.toolResultSanitizer = createToolResultSanitizer({
			riskyFields: this.config.riskyFields,
			traversal: this.config.traversal,
			toolRules: options.config?.toolRules ?? (options.useDefaultToolRules === true ? this.config.toolRules : []),
			defaultRiskLevel: options.defaultRiskLevel ?? "medium",
			useTier1Classification: options.enableTier1 ?? true,
			useTier2Classification: false,
			tier2Config: options.tier2Config,
			tier2Weights: options.tier2Weights,
			blockHighRisk: options.blockHighRisk ?? false,
			cumulativeRiskThresholds: this.config.cumulativeRiskThresholds,
		});

		this.patternDetector = createPatternDetector();

		// Initialize Tier 2 classifier if enabled
		if (options.enableTier2 ?? true) {
			this.tier2Classifier = createTier2Classifier(options.tier2Config);
			if (options.tier2Weights) {
				this.tier2Classifier.loadWeights(options.tier2Weights);
			}
		}
	}

	/**
	 * Load MLP weights for Tier 2 classification
	 *
	 * Call this after construction if weights weren't provided in options.
	 * If Tier 2 wasn't enabled at construction, this will create the classifier.
	 *
	 * @param weights - MLP weights exported from Python
	 */
	loadTier2Weights(weights: MLPWeights): void {
		if (!this.tier2Classifier) {
			this.tier2Classifier = createTier2Classifier();
		}
		this.tier2Classifier.loadWeights(weights);
	}

	/**
	 * Pre-load the Tier 2 embedding model
	 *
	 * Call this at startup to avoid latency on first classification.
	 * The embedding model download (~30MB) is cached locally.
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
		let maxSentence: string | undefined;
		let tier2Risk: RiskLevel = "low";

		if (this.tier2Classifier) {
			const strings = extractStrings(value, this.tier2Fields);
			const combinedText = strings.join("\n\n");

			if (combinedText.length > 0) {
				const tier2Result = await this.tier2Classifier.classifyBySentence(combinedText);
				if (!tier2Result.skipped) {
					tier2Score = tier2Result.score;
					tier2Risk = this.tier2Classifier.getRiskLevel(tier2Result.score);
					maxSentence = tier2Result.maxSentence;
				}
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
		const hasThreats =
			detections.length > 0 ||
			fieldsSanitized.length > 0 ||
			(tier2Score !== undefined && tier2Score >= this.config.tier2.highRiskThreshold);

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
