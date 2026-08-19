/**
 * Tool Result Sanitizer
 *
 * Main integration layer that sanitizes complete tool results.
 * Handles structure traversal, risky field detection, and applies
 * appropriate sanitization based on risk level.
 */

import { createPatternDetector, type PatternDetector } from "../classifiers/pattern-detector";
import {
	DANGEROUS_KEYS,
	DEFAULT_MAX_FIELD_ANALYSIS_LENGTH,
	DEFAULT_RISKY_FIELDS,
	DEFAULT_TRAVERSAL_CONFIG,
} from "../config";
import { decodeAllLevels } from "../sanitizers/encoding-detector";
import type {
	CumulativeRiskTracker,
	DataBoundary,
	RiskLevel,
	RiskyFieldConfig,
	SanitizableValue,
	SanitizationContext,
	SanitizationMetadata,
	SanitizationMethod,
	SanitizationResult,
	TraversalConfig,
} from "../types";
import { generateDataBoundary, wrapWithBoundary } from "../utils/boundary";
import { isRiskyField } from "../utils/field-detection";
import {
	createSizeMetrics,
	detectStructureType,
	getWrappedData,
	isPaginatedResponse,
	shouldContinueTraversal,
	updateSizeMetrics,
} from "../utils/structure";

/** Risk levels in ascending order, for max-comparison. */
const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

/**
 * Configuration for the tool result sanitizer
 */
export interface ToolResultSanitizerConfig {
	/** Risky field configuration */
	riskyFields: RiskyFieldConfig;
	/** Traversal limits */
	traversal: TraversalConfig;
	/** Default risk level when not determined by classification */
	defaultRiskLevel: RiskLevel;
	/** Whether to use Tier 1 classification */
	useTier1Classification: boolean;
	/**
	 * Wrap sanitized string fields with `[UD-<id>]...[/UD-<id>]` boundary
	 * markers. Default: false. When disabled, boundary generation is skipped
	 * entirely (no `generateDataBoundary()` call per tool result).
	 */
	annotateBoundary: boolean;
	/**
	 * Per-field cap (characters) on the text Tier 1 runs heavy regex / encoding
	 * detection over. ReDoS guard — content past the cap is not analysed and
	 * `metadata.analysisTruncated` is set. Default: 50000.
	 */
	maxFieldAnalysisLength: number;
	/** Cumulative risk thresholds */
	cumulativeRiskThresholds: {
		medium: number;
		high: number;
		patterns: number;
		mediumFraction: number;
		patternsFraction: number;
	};
}

/**
 * Default configuration
 */
export const DEFAULT_TOOL_RESULT_SANITIZER_CONFIG: ToolResultSanitizerConfig = {
	riskyFields: DEFAULT_RISKY_FIELDS,
	traversal: DEFAULT_TRAVERSAL_CONFIG,
	defaultRiskLevel: "low",
	useTier1Classification: true,
	annotateBoundary: false,
	maxFieldAnalysisLength: DEFAULT_MAX_FIELD_ANALYSIS_LENGTH,
	cumulativeRiskThresholds: {
		medium: 3,
		high: 1,
		patterns: 3,
		mediumFraction: 0.25,
		patternsFraction: 0.25,
	},
};

/**
 * Options for sanitizing a tool result
 */
export interface SanitizeToolResultOptions {
	/** Name of the tool that produced this result */
	toolName: string;
	/** Tool category/vertical (e.g., "documents", "hris") */
	vertical?: string;
	/** Resource type (e.g., "files", "employees") */
	resource?: string;
	/** Override risk level (skip classification) */
	riskLevel?: RiskLevel;
	/** Custom boundary to use */
	boundary?: DataBoundary;
}

/**
 * Tool Result Sanitizer
 *
 * Sanitizes complete tool results by:
 * 1. Detecting structure type (array, object, paginated, etc.)
 * 2. Traversing recursively with depth/size limits
 * 3. Identifying risky fields based on configuration
 * 4. Classifying content risk using Tier 1 patterns
 * 5. Applying appropriate sanitization methods
 * 6. Tracking cumulative risk for fragmented attack detection
 */
export class ToolResultSanitizer {
	private config: ToolResultSanitizerConfig;
	private patternDetector: PatternDetector;

	constructor(config: Partial<ToolResultSanitizerConfig> = {}) {
		this.config = { ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG, ...config };
		this.patternDetector = createPatternDetector();
	}

	/**
	 * Sanitize a complete tool result
	 *
	 * @param value - The tool result to sanitize
	 * @param options - Sanitization options
	 * @returns Sanitized result with metadata
	 */
	sanitize<T = unknown>(value: T, options: SanitizeToolResultOptions): SanitizationResult<T> {
		const startTime = performance.now();

		// Generate boundary for this result only when wrapping is enabled —
		// skipped entirely when `annotateBoundary` is off to avoid the
		// nanoid() call and tag-string allocation on every tool result.
		const boundary = this.config.annotateBoundary ? (options.boundary ?? generateDataBoundary()) : undefined;

		// Initialize cumulative risk tracker
		const cumulativeRisk = this.createCumulativeRiskTracker();

		// Initialize size metrics
		const sizeMetrics = createSizeMetrics();

		// Create initial context
		const context: SanitizationContext = {
			path: "",
			fieldName: "",
			toolName: options.toolName,
			vertical: options.vertical ?? this.extractVertical(options.toolName),
			resource: options.resource ?? this.extractResource(options.toolName),
			riskLevel: options.riskLevel ?? this.config.defaultRiskLevel,
			boundary,
			cumulativeRisk,
		};

		// Initialize metadata
		const metadata: SanitizationMetadata = {
			fieldsSanitized: [],
			methodsByField: {},
			patternsRemovedByField: {},
			overallRiskLevel: context.riskLevel,
			cumulativeRiskEscalated: false,
			totalLatencyMs: 0,
			sizeMetrics,
			riskyFieldNames: [],
		};

		// Sanitize the value. A top-level string IS the entire tool result, so run
		// Tier 1 detection on it directly — sanitizeValue's recursion only scans
		// strings under risky object fields, so a bare-string result would
		// otherwise skip Tier 1 entirely (a real gap when Tier 2 is off/unavailable).
		const sanitized =
			typeof value === "string"
				? this.sanitizeStringField(value, context, metadata, true)
				: this.sanitizeValue(value as SanitizableValue, context, metadata, 0);

		// Check if cumulative risk requires escalation (fragmented attack across
		// many fields). Raise (max) rather than overwrite so it can't downgrade a
		// per-field `critical` back to `high`.
		if (this.shouldEscalate(cumulativeRisk)) {
			metadata.cumulativeRiskEscalated = true;
			this.raiseOverallRisk(metadata, "high");
		}

		metadata.totalLatencyMs = performance.now() - startTime;
		metadata.sizeMetrics = sizeMetrics;
		metadata.riskyFieldNames = [...new Set(metadata.riskyFieldNames)];

		return {
			sanitized: sanitized as T,
			metadata,
		};
	}

	/**
	 * Recursively sanitize a value
	 */
	private sanitizeValue(
		value: SanitizableValue,
		context: SanitizationContext,
		metadata: SanitizationMetadata,
		depth: number,
		detect: boolean = true,
	): SanitizableValue {
		// Track size for traversal limiting
		updateSizeMetrics(metadata.sizeMetrics, value);

		// Check traversal limits
		if (
			!shouldContinueTraversal(
				metadata.sizeMetrics,
				depth,
				this.config.traversal.maxSize,
				this.config.traversal.maxDepth,
			)
		) {
			return value;
		}

		// Handle null/undefined
		if (value === null || value === undefined) {
			return value;
		}

		// Handle arrays
		if (Array.isArray(value)) {
			return this.sanitizeArray(value, context, metadata, depth, detect);
		}

		// Handle objects. Only PLAIN objects are traversed/rebuilt — they round-trip
		// faithfully through Object.entries. Non-plain objects (Date, Map, Set,
		// Buffer, RegExp, class instances) have no enumerable string fields either
		// tier scans, and a rebuild would corrupt them (e.g. `new Date()` -> `{}`).
		// Detect-and-gate returns the original value, so pass them through unchanged.
		if (typeof value === "object") {
			const proto = Object.getPrototypeOf(value);
			if (proto === Object.prototype || proto === null) {
				return this.sanitizeObject(value as Record<string, SanitizableValue>, context, metadata, depth, detect);
			}
			return value;
		}

		// Primitives (non-string) pass through
		return value;
	}

	/**
	 * Sanitize an array
	 */
	private sanitizeArray(
		arr: SanitizableValue[],
		context: SanitizationContext,
		metadata: SanitizationMetadata,
		depth: number,
		detect: boolean = true,
	): SanitizableValue[] {
		// Array/object counting lives in updateSizeMetrics (called on every value
		// in sanitizeValue, and at the direct call sites below that bypass it).

		// Large arrays: bound Tier 1 DETECTION cost by only detecting on the first
		// `scanLimit` items. Items past the limit are STILL fully traversed — for
		// prototype-pollution key stripping, depth/size limits, and boundary
		// wrapping — they just skip the expensive per-string Tier 1 analysis
		// (passing detect=false down). Data is never dropped (the previous
		// behavior returned only the first 100 items plus a notice), and the
		// reduced detection coverage is flagged via `analysisTruncated`. Tier 2
		// still scans every string via its own walk.
		const scanLimit = this.detectionScanLimit(arr.length, metadata);

		return arr.map((item, index) => {
			const itemContext = {
				...context,
				path: `${context.path}[${index}]`,
			};
			return this.sanitizeValue(item, itemContext, metadata, depth + 1, detect && index < scanLimit);
		});
	}

	/**
	 * Detection scan limit for a container of `size` entries. Bounds Tier 1
	 * DETECTION cost on very wide arrays/objects: entries past the limit are still
	 * traversed (structure, prototype-pollution stripping, Tier 2's own walk) —
	 * only their per-entry Tier 1 analysis is skipped. Flags `analysisTruncated`
	 * when it caps so the coverage loss is surfaced.
	 */
	private detectionScanLimit(size: number, metadata: SanitizationMetadata): number {
		const isLarge = this.config.traversal.skipLargeArrays && size > this.config.traversal.largeArrayThreshold;
		const limit = isLarge ? Math.min(100, size) : size;
		if (isLarge && limit < size) metadata.analysisTruncated = true;
		return limit;
	}

	/**
	 * Sanitize an object
	 */
	private sanitizeObject(
		obj: Record<string, SanitizableValue>,
		context: SanitizationContext,
		metadata: SanitizationMetadata,
		depth: number,
		detect: boolean = true,
	): Record<string, SanitizableValue> {
		// objectCount is incremented once in updateSizeMetrics (via sanitizeValue).

		// Check for paginated response
		if (isPaginatedResponse(obj)) {
			return this.sanitizePaginatedResponse(obj, context, metadata, depth, detect);
		}

		// Check for wrapped response
		const structureType = detectStructureType(obj);
		if (structureType === "wrapped") {
			return this.sanitizeWrappedResponse(obj, context, metadata, depth, detect);
		}

		// Regular object - process each field. Wide objects bound Tier 1 detection
		// past `scanLimit` (see `detectionScanLimit`); entries are still traversed.
		const result: Record<string, SanitizableValue> = {};
		const entries = Object.entries(obj);
		const scanLimit = this.detectionScanLimit(entries.length, metadata);

		for (let index = 0; index < entries.length; index++) {
			const [key, val] = entries[index];
			const entryDetect = detect && index < scanLimit;
			// Prototype-pollution key stripping is a STRUCTURAL protection — always
			// applied, even when detection is skipped.
			if (DANGEROUS_KEYS.has(key)) {
				const keyPath = context.path ? `${context.path}.${key}` : key;
				(metadata.dangerousKeysRemoved ??= []).push(keyPath);
				continue;
			}
			const fieldPath = context.path ? `${context.path}.${key}` : key;
			// Detect injection hidden in the key itself (never rewritten).
			if (entryDetect) this.detectInKey(key, fieldPath, context, metadata);
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			// Check if this is a risky field that needs sanitization
			if (this.isFieldRisky(key, context.toolName) && typeof val === "string") {
				if (entryDetect) metadata.riskyFieldNames.push(key);
				result[key] = this.sanitizeStringField(val, fieldContext, metadata, entryDetect);
			} else {
				// Recurse into non-risky fields
				result[key] = this.sanitizeValue(val, fieldContext, metadata, depth + 1, entryDetect);
			}
		}

		return result;
	}

	/**
	 * Sanitize a paginated response
	 */
	private sanitizePaginatedResponse(
		obj: Record<string, SanitizableValue>,
		context: SanitizationContext,
		metadata: SanitizationMetadata,
		depth: number,
		detect: boolean = true,
	): Record<string, SanitizableValue> {
		const result: Record<string, SanitizableValue> = {};
		const dataKeys = new Set(["data", "results", "items", "records"]);
		const entries = Object.entries(obj);
		const scanLimit = this.detectionScanLimit(entries.length, metadata);

		for (let index = 0; index < entries.length; index++) {
			const [key, val] = entries[index];
			const entryDetect = detect && index < scanLimit;
			if (DANGEROUS_KEYS.has(key)) {
				const keyPath = context.path ? `${context.path}.${key}` : key;
				(metadata.dangerousKeysRemoved ??= []).push(keyPath);
				continue;
			}

			const fieldPath = context.path ? `${context.path}.${key}` : key;
			// Detect injection hidden in the key itself (never rewritten).
			if (entryDetect) this.detectInKey(key, fieldPath, context, metadata);
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			if (dataKeys.has(key) && Array.isArray(val)) {
				// Direct sanitizeArray bypasses sanitizeValue, so count the container here.
				updateSizeMetrics(metadata.sizeMetrics, val as SanitizableValue[]);
				result[key] = this.sanitizeArray(
					val as SanitizableValue[],
					fieldContext,
					metadata,
					depth + 1,
					entryDetect,
				);
			} else {
				// Recurse into non-data fields so nested dangerous keys are filtered too
				result[key] = this.sanitizeValue(val, fieldContext, metadata, depth + 1, entryDetect);
			}
		}

		return result;
	}

	/**
	 * Sanitize a wrapped response
	 */
	private sanitizeWrappedResponse(
		obj: Record<string, SanitizableValue>,
		context: SanitizationContext,
		metadata: SanitizationMetadata,
		depth: number,
		detect: boolean = true,
	): Record<string, SanitizableValue> {
		const result: Record<string, SanitizableValue> = {};
		const entries = Object.entries(obj);
		const scanLimit = this.detectionScanLimit(entries.length, metadata);

		for (let index = 0; index < entries.length; index++) {
			const [key, val] = entries[index];
			const entryDetect = detect && index < scanLimit;
			if (DANGEROUS_KEYS.has(key)) {
				const keyPath = context.path ? `${context.path}.${key}` : key;
				(metadata.dangerousKeysRemoved ??= []).push(keyPath);
				continue;
			}
			const fieldPath = context.path ? `${context.path}.${key}` : key;
			// Detect injection hidden in the key itself (never rewritten).
			if (entryDetect) this.detectInKey(key, fieldPath, context, metadata);
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			// Check if this is the data wrapper
			const wrappedData = getWrappedData({ [key]: val });
			if (wrappedData) {
				// Direct sanitizeArray bypasses sanitizeValue, so count the container here.
				updateSizeMetrics(metadata.sizeMetrics, val as SanitizableValue[]);
				result[key] = this.sanitizeArray(
					val as SanitizableValue[],
					fieldContext,
					metadata,
					depth + 1,
					entryDetect,
				);
			} else {
				result[key] = this.sanitizeValue(val, fieldContext, metadata, depth + 1, entryDetect);
			}
		}

		return result;
	}

	/**
	 * Sanitize a string field
	 */
	private sanitizeStringField(
		value: string,
		context: SanitizationContext,
		metadata: SanitizationMetadata,
		detect: boolean = true,
	): string {
		// Count risky-field content toward the size budget. Previously these
		// strings bypassed updateSizeMetrics entirely (they're handled here, not
		// via sanitizeValue), so the maxSize cap never applied to the fields that
		// carry the DoS/latency risk. Always runs (structural accounting).
		updateSizeMetrics(metadata.sizeMetrics, value);

		// Tier 1 detection. Skipped (detect=false) for tail items of very large
		// arrays — those still get structural handling (the size accounting above
		// and boundary wrapping below) but not the expensive per-string analysis.
		if (detect) {
			// Determine risk level for this field
			let riskLevel = context.riskLevel;

			// Cap the text Tier 1 runs heavy regex / encoding detection over. Beyond
			// the cap only the head is analysed and `analysisTruncated` is flagged —
			// bounds worst-case regex cost on hostile inputs (ReDoS guard).
			const cap = this.config.maxFieldAnalysisLength;
			const analysisValue = value.length > cap ? value.slice(0, cap) : value;
			if (value.length > cap) metadata.analysisTruncated = true;

			// Every risky string field counts toward the cumulative-risk
			// denominator, not just ones that matched a pattern. Otherwise the
			// fraction check becomes degenerate — matched/matched = 100% trivially
			// passes, which defeats the fraction threshold for list responses
			// where most items are benign.
			if (context.cumulativeRisk) {
				context.cumulativeRisk.totalFieldsProcessed++;
			}

			// Tier 1 detection (detect-and-gate: analyze only, never rewrite the
			// field). Records detected patterns and escalates the field's risk
			// level; the block/allow decision is made upstream from that risk level.
			let tier1Patterns: string[] = [];
			if (this.config.useTier1Classification) {
				const classificationResult = this.patternDetector.analyze(analysisValue);

				if (classificationResult.hasDetections) {
					tier1Patterns = [...new Set(classificationResult.matches.map((m) => m.pattern))];

					// Escalate risk based on classification
					if (classificationResult.suggestedRisk === "critical") {
						riskLevel = "critical";
					} else if (classificationResult.suggestedRisk === "high" && riskLevel !== "critical") {
						riskLevel = "high";
					} else if (classificationResult.suggestedRisk === "medium" && riskLevel === "low") {
						riskLevel = "medium";
					}

					// Update cumulative risk tracker — only for real regex pattern matches,
					// not structural-only detections (high_entropy, excessive_length, etc.).
					// Structural anomalies fire on legitimate content like UUID-appended field
					// values in list responses and would cause false cumulative escalations.
					// Pass suggestedRisk rather than the field's post-escalation riskLevel so that
					// a low-severity match doesn't inflate mediumRiskCount via the context default.
					if (context.cumulativeRisk && classificationResult.matches.length > 0) {
						this.updateCumulativeRisk(
							context.cumulativeRisk,
							classificationResult.suggestedRisk,
							tier1Patterns,
						);
					}
				}
			}

			// Suspicious encoding is EVIDENCE-DRIVEN. An encoded blob (base64/ROT13/
			// Morse/hex/HTML-entity/etc., including chained encodings) hides content
			// from the Tier 1 scan above, so decode it and re-run the REAL pattern
			// detector on the decoded text. Escalate only if the DECODED content trips
			// an actual attack pattern — never on generic keywords. This is what makes
			// a benign base64 body (e.g. a Gmail message that merely contains the word
			// "ignore") NOT a false positive, while a base64-wrapped injection still
			// escalates, with its real patterns reported in `detections`.
			let escalatedFromEncoding = false;
			if (this.config.useTier1Classification) {
				const { text: decoded, levels } = decodeAllLevels(analysisValue);
				if (levels > 0 && decoded !== analysisValue) {
					const encResult = this.patternDetector.analyze(decoded);
					if (encResult.hasDetections && encResult.matches.length > 0) {
						const encPatterns = [...new Set(encResult.matches.map((m) => m.pattern))];
						tier1Patterns = [...new Set([...tier1Patterns, ...encPatterns])];
						escalatedFromEncoding = true;
						if (encResult.suggestedRisk === "critical") riskLevel = "critical";
						else if (encResult.suggestedRisk === "high" && riskLevel !== "critical") riskLevel = "high";
						else if (encResult.suggestedRisk === "medium" && riskLevel === "low") riskLevel = "medium";
						if (context.cumulativeRisk) {
							this.updateCumulativeRisk(context.cumulativeRisk, encResult.suggestedRisk, encPatterns);
						}
					}
				}
			}

			// Propagate this field's (possibly escalated) risk into the overall
			// result risk. Raising per field lets a single `critical` field surface
			// as `critical` overall — cumulative escalation alone only reaches `high`.
			// No-op for benign fields (risk stays at the "low" default).
			this.raiseOverallRisk(metadata, riskLevel);

			// Record detection metadata, sourced from the detector (not from mutation
			// side-effects), so every detected pattern is reported — including
			// medium-severity matches and matches found only on normalised text.
			if (tier1Patterns.length > 0 || escalatedFromEncoding) {
				metadata.fieldsSanitized.push(context.path);
				const methods: SanitizationMethod[] = [];
				if (tier1Patterns.length > 0) methods.push("pattern_removal");
				if (escalatedFromEncoding) methods.push("encoding_detection");
				metadata.methodsByField[context.path] = methods;
				if (tier1Patterns.length > 0) {
					metadata.patternsRemovedByField[context.path] = tier1Patterns;
				}
			}
		}

		// Detect-and-gate: return the ORIGINAL content, never rewritten. Wrap it
		// in boundary markers when annotation is enabled (structural
		// data/instruction separation). Blocking is expressed upstream via
		// `allowed: false` derived from the escalated risk level — not by
		// mutating the field here.
		return context.boundary ? wrapWithBoundary(value, context.boundary) : value;
	}

	// ==========================================================================
	// Helper Methods
	// ==========================================================================

	/**
	 * Check if a field is risky
	 */
	private isFieldRisky(fieldName: string, toolName: string): boolean {
		return isRiskyField(fieldName, this.config.riskyFields, toolName);
	}

	/**
	 * Detect-only scan of an object KEY. Keys are never rewritten — that would
	 * change the object's shape — but an injection hidden in a key (e.g. an API
	 * that returns attacker-controlled text as map keys) must still be detected
	 * so it contributes to the risk/allow decision. Records detected patterns in
	 * metadata under `"<path> (key)"` and escalates cumulative risk like a
	 * detected value field. No-op for short/benign keys (the detector's fast
	 * filter short-circuits, so this is cheap on identifier-shaped keys).
	 */
	private detectInKey(
		key: string,
		keyPath: string,
		context: SanitizationContext,
		metadata: SanitizationMetadata,
	): void {
		if (!this.config.useTier1Classification || key.length < 3) return;
		const cap = this.config.maxFieldAnalysisLength;
		const analysisKey = key.length > cap ? key.slice(0, cap) : key;
		// Flag reduced coverage (surfaced as coverageDegraded), matching the value
		// path — an injection hidden past the cap in a key is unscanned.
		if (key.length > cap) metadata.analysisTruncated = true;
		const result = this.patternDetector.analyze(analysisKey);
		if (!result.hasDetections || result.matches.length === 0) return;

		const patterns = [...new Set(result.matches.map((m) => m.pattern))];
		const path = `${keyPath} (key)`;
		const methods: SanitizationMethod[] = ["pattern_removal"];
		metadata.fieldsSanitized.push(path);
		metadata.methodsByField[path] = methods;
		metadata.patternsRemovedByField[path] = patterns;
		this.raiseOverallRisk(metadata, result.suggestedRisk);
		if (context.cumulativeRisk) {
			context.cumulativeRisk.totalFieldsProcessed++;
			this.updateCumulativeRisk(context.cumulativeRisk, result.suggestedRisk, patterns);
		}
	}

	/**
	 * Create a cumulative risk tracker using the configured cumulative risk thresholds.
	 */
	private createCumulativeRiskTracker(): CumulativeRiskTracker {
		const thresholds = this.config.cumulativeRiskThresholds;
		return {
			mediumRiskCount: 0,
			highRiskCount: 0,
			suspiciousPatterns: [],
			totalFieldsProcessed: 0,
			escalationThreshold: {
				medium: thresholds.medium,
				high: thresholds.high,
				patterns: thresholds.patterns,
				mediumFraction: thresholds.mediumFraction,
				patternsFraction: thresholds.patternsFraction,
			},
		};
	}

	/**
	 * Update cumulative risk tracker. `totalFieldsProcessed` is incremented
	 * by the caller for every risky string field — NOT here — so the
	 * fraction checks in `shouldEscalate` have a meaningful denominator
	 * (every field processed, not only matched ones).
	 */
	private updateCumulativeRisk(tracker: CumulativeRiskTracker, riskLevel: RiskLevel, patterns: string[]): void {
		if (riskLevel === "high" || riskLevel === "critical") {
			tracker.highRiskCount++;
		} else if (riskLevel === "medium") {
			tracker.mediumRiskCount++;
		}

		if (patterns.length > 0) {
			tracker.suspiciousPatterns.push(...patterns);
		}
	}

	/**
	 * Check if cumulative risk should trigger escalation
	 */
	private shouldEscalate(tracker: CumulativeRiskTracker): boolean {
		const t = tracker.escalationThreshold;

		// A single high-risk field still escalates — these come from genuine high-severity
		// regex matches (role markers, instruction overrides) that indicate real threats.
		if (tracker.highRiskCount >= t.high) {
			return true;
		}

		// Medium-risk and pattern escalations require both an absolute minimum count
		// AND a fraction of total processed fields. This prevents list responses with
		// many items from escalating just because a small number of items happen to
		// contain flagged content, while still catching concentrated fragmented attacks.
		const total = Math.max(tracker.totalFieldsProcessed, 1);

		if (tracker.mediumRiskCount >= t.medium && tracker.mediumRiskCount / total >= t.mediumFraction) {
			return true;
		}

		if (
			tracker.suspiciousPatterns.length >= t.patterns &&
			tracker.suspiciousPatterns.length / total >= t.patternsFraction
		) {
			return true;
		}

		return false;
	}

	/**
	 * Raise `metadata.overallRiskLevel` to `level` if `level` is higher —
	 * never lowers it. Keeps the overall result risk as the max of every
	 * per-field risk and any cumulative escalation.
	 */
	private raiseOverallRisk(metadata: SanitizationMetadata, level: RiskLevel): void {
		if (RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(metadata.overallRiskLevel)) {
			metadata.overallRiskLevel = level;
		}
	}

	/**
	 * Extract vertical from tool name (e.g., "documents_list" -> "documents")
	 */
	private extractVertical(toolName: string): string {
		const parts = toolName.split("_");
		if (parts.length >= 2) {
			// Skip "unified" prefix if present
			return parts[0] === "unified" ? parts[1] : parts[0];
		}
		return "unknown";
	}

	/**
	 * Extract resource from tool name (e.g., "documents_list_files" -> "files")
	 */
	private extractResource(toolName: string): string {
		const parts = toolName.split("_");
		if (parts.length >= 3) {
			return parts[parts.length - 1];
		}
		return "unknown";
	}
}

/**
 * Create a tool result sanitizer with default configuration
 */
export function createToolResultSanitizer(config?: Partial<ToolResultSanitizerConfig>): ToolResultSanitizer {
	return new ToolResultSanitizer(config);
}

/**
 * Quick function to sanitize a tool result
 */
export function sanitizeToolResult<T = unknown>(
	value: T,
	toolName: string,
	options?: Partial<SanitizeToolResultOptions>,
): SanitizationResult<T> {
	const sanitizer = createToolResultSanitizer();
	return sanitizer.sanitize(value, { toolName, ...options });
}
