/**
 * Tool Result Sanitizer
 *
 * Main integration layer that sanitizes complete tool results.
 * Handles structure traversal, risky field detection, and applies
 * appropriate sanitization based on risk level.
 */

import { createPatternDetector, type PatternDetector } from "../classifiers/pattern-detector";
import { DANGEROUS_KEYS, DEFAULT_RISKY_FIELDS, DEFAULT_TRAVERSAL_CONFIG } from "../config";
import { createSanitizer, type Sanitizer } from "../sanitizers/sanitizer";
import type {
	CumulativeRiskTracker,
	DataBoundary,
	RiskLevel,
	RiskyFieldConfig,
	SanitizableValue,
	SanitizationContext,
	SanitizationMetadata,
	SanitizationResult,
	TraversalConfig,
} from "../types";
import { generateDataBoundary } from "../utils/boundary";
import { isRiskyField } from "../utils/field-detection";
import {
	createSizeMetrics,
	detectStructureType,
	getWrappedData,
	isPaginatedResponse,
	shouldContinueTraversal,
	updateSizeMetrics,
} from "../utils/structure";

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
	/** Whether to block high/critical risk entirely */
	blockHighRisk: boolean;
	/**
	 * Wrap sanitized string fields with `[UD-<id>]...[/UD-<id>]` boundary
	 * markers. Default: false. When disabled, boundary generation is skipped
	 * entirely (no `generateDataBoundary()` call per tool result).
	 */
	annotateBoundary: boolean;
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
	defaultRiskLevel: "medium",
	useTier1Classification: true,
	blockHighRisk: false,
	annotateBoundary: false,
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
	private sanitizer: Sanitizer;
	private patternDetector: PatternDetector;

	constructor(config: Partial<ToolResultSanitizerConfig> = {}) {
		this.config = { ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG, ...config };
		this.sanitizer = createSanitizer({ annotateBoundary: this.config.annotateBoundary });
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

		// Sanitize the value
		const sanitized = this.sanitizeValue(value as SanitizableValue, context, metadata, 0);

		// Check if cumulative risk requires escalation
		if (this.shouldEscalate(cumulativeRisk)) {
			metadata.cumulativeRiskEscalated = true;
			metadata.overallRiskLevel = "high";
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
			return this.sanitizeArray(value, context, metadata, depth);
		}

		// Handle objects
		if (typeof value === "object") {
			return this.sanitizeObject(value as Record<string, SanitizableValue>, context, metadata, depth);
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
	): SanitizableValue[] {
		metadata.sizeMetrics.arrayCount++;

		// Check for large arrays
		if (this.config.traversal.skipLargeArrays && arr.length > this.config.traversal.largeArrayThreshold) {
			// Sanitize first N items only
			const sampleSize = Math.min(100, arr.length);
			const sanitized: SanitizableValue[] = [];

			for (let i = 0; i < sampleSize; i++) {
				const itemContext = {
					...context,
					path: `${context.path}[${i}]`,
				};
				sanitized.push(this.sanitizeValue(arr[i], itemContext, metadata, depth + 1));
			}

			// Add notice about skipped items
			if (arr.length > sampleSize) {
				sanitized.push(`[${arr.length - sampleSize} more items - sanitization skipped for performance]`);
			}

			return sanitized;
		}

		// Sanitize all items
		return arr.map((item, index) => {
			const itemContext = {
				...context,
				path: `${context.path}[${index}]`,
			};
			return this.sanitizeValue(item, itemContext, metadata, depth + 1);
		});
	}

	/**
	 * Sanitize an object
	 */
	private sanitizeObject(
		obj: Record<string, SanitizableValue>,
		context: SanitizationContext,
		metadata: SanitizationMetadata,
		depth: number,
	): Record<string, SanitizableValue> {
		metadata.sizeMetrics.objectCount++;

		// Check for paginated response
		if (isPaginatedResponse(obj)) {
			return this.sanitizePaginatedResponse(obj, context, metadata, depth);
		}

		// Check for wrapped response
		const structureType = detectStructureType(obj);
		if (structureType === "wrapped") {
			return this.sanitizeWrappedResponse(obj, context, metadata, depth);
		}

		// Regular object - process each field
		const result: Record<string, SanitizableValue> = {};

		for (const [key, val] of Object.entries(obj)) {
			if (DANGEROUS_KEYS.has(key)) {
				const keyPath = context.path ? `${context.path}.${key}` : key;
				(metadata.dangerousKeysRemoved ??= []).push(keyPath);
				continue;
			}
			const fieldPath = context.path ? `${context.path}.${key}` : key;
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			// Check if this is a risky field that needs sanitization
			if (this.isFieldRisky(key, context.toolName) && typeof val === "string") {
				metadata.riskyFieldNames.push(key);
				result[key] = this.sanitizeStringField(val, fieldContext, metadata);
			} else {
				// Recurse into non-risky fields
				result[key] = this.sanitizeValue(val, fieldContext, metadata, depth + 1);
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
	): Record<string, SanitizableValue> {
		const result: Record<string, SanitizableValue> = {};
		const dataKeys = new Set(["data", "results", "items", "records"]);

		for (const [key, val] of Object.entries(obj)) {
			if (DANGEROUS_KEYS.has(key)) {
				const keyPath = context.path ? `${context.path}.${key}` : key;
				(metadata.dangerousKeysRemoved ??= []).push(keyPath);
				continue;
			}

			const fieldContext = {
				...context,
				path: context.path ? `${context.path}.${key}` : key,
				fieldName: key,
			};

			if (dataKeys.has(key) && Array.isArray(val)) {
				result[key] = this.sanitizeArray(val as SanitizableValue[], fieldContext, metadata, depth + 1);
			} else {
				// Recurse into non-data fields so nested dangerous keys are filtered too
				result[key] = this.sanitizeValue(val, fieldContext, metadata, depth + 1);
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
	): Record<string, SanitizableValue> {
		const result: Record<string, SanitizableValue> = {};

		for (const [key, val] of Object.entries(obj)) {
			if (DANGEROUS_KEYS.has(key)) {
				const keyPath = context.path ? `${context.path}.${key}` : key;
				(metadata.dangerousKeysRemoved ??= []).push(keyPath);
				continue;
			}
			const fieldPath = context.path ? `${context.path}.${key}` : key;
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			// Check if this is the data wrapper
			const wrappedData = getWrappedData({ [key]: val });
			if (wrappedData) {
				result[key] = this.sanitizeArray(val as SanitizableValue[], fieldContext, metadata, depth + 1);
			} else {
				result[key] = this.sanitizeValue(val, fieldContext, metadata, depth + 1);
			}
		}

		return result;
	}

	/**
	 * Sanitize a string field
	 */
	private sanitizeStringField(value: string, context: SanitizationContext, metadata: SanitizationMetadata): string {
		metadata.sizeMetrics.stringCount++;

		// Determine risk level for this field
		let riskLevel = context.riskLevel;

		// Every risky string field counts toward the cumulative-risk
		// denominator, not just ones that matched a pattern. Otherwise the
		// fraction check becomes degenerate — matched/matched = 100% trivially
		// passes, which defeats the fraction threshold for list responses
		// where most items are benign.
		if (context.cumulativeRisk) {
			context.cumulativeRisk.totalFieldsProcessed++;
		}

		// Use Tier 1 classification if enabled
		let tier1Patterns: string[] = [];
		if (this.config.useTier1Classification) {
			const classificationResult = this.patternDetector.analyze(value);

			if (classificationResult.hasDetections) {
				tier1Patterns = classificationResult.matches.map((m) => m.pattern);

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

		// Block if high or critical and blocking is enabled
		if (this.config.blockHighRisk && (riskLevel === "high" || riskLevel === "critical")) {
			metadata.fieldsSanitized.push(context.path);
			metadata.methodsByField[context.path] = tier1Patterns.length > 0 ? ["pattern_removal"] : [];
			if (tier1Patterns.length > 0) {
				metadata.patternsRemovedByField[context.path] = tier1Patterns;
			}
			return "[CONTENT BLOCKED FOR SECURITY]";
		}

		// Apply sanitization
		const result = this.sanitizer.sanitize(value, {
			riskLevel,
			boundary: context.boundary,
			fieldName: context.fieldName,
		});

		// Update metadata
		if (result.methodsApplied.length > 0) {
			metadata.fieldsSanitized.push(context.path);
			metadata.methodsByField[context.path] = result.methodsApplied;
			if (result.patternsRemoved.length > 0) {
				metadata.patternsRemovedByField[context.path] = result.patternsRemoved;
			}
		}

		return result.sanitized;
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
