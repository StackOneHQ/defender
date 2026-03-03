/**
 * Tool Result Sanitizer
 *
 * Main integration layer that sanitizes complete tool results.
 * Handles structure traversal, risky field detection, and applies
 * appropriate sanitization based on risk level.
 */

import type { MLPWeights } from "../classifiers/mlp";
import { createPatternDetector, type PatternDetector } from "../classifiers/pattern-detector";
import {
	createTier2Classifier,
	type Tier2Classifier,
	type Tier2ClassifierConfig,
} from "../classifiers/tier2-classifier";
import { DEFAULT_RISKY_FIELDS, DEFAULT_TOOL_RULES, DEFAULT_TRAVERSAL_CONFIG } from "../config";
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
	ToolSanitizationRule,
	TraversalConfig,
} from "../types";
import { generateDataBoundary } from "../utils/boundary";
import { getToolRule, isRiskyField, shouldSkipField } from "../utils/field-detection";
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
	/** Per-tool rules */
	toolRules: ToolSanitizationRule[];
	/** Default risk level when not determined by classification */
	defaultRiskLevel: RiskLevel;
	/** Whether to use Tier 1 classification */
	useTier1Classification: boolean;
	/** Whether to use Tier 2 classification (requires async sanitization) */
	useTier2Classification: boolean;
	/** Tier 2 classifier configuration */
	tier2Config?: Partial<Tier2ClassifierConfig>;
	/** MLP weights for Tier 2 (must be provided if useTier2Classification is true) */
	tier2Weights?: MLPWeights;
	/** Whether to block high/critical risk entirely */
	blockHighRisk: boolean;
	/** Cumulative risk thresholds */
	cumulativeRiskThresholds: {
		medium: number;
		high: number;
		patterns: number;
	};
}

/**
 * Default configuration
 */
export const DEFAULT_TOOL_RESULT_SANITIZER_CONFIG: ToolResultSanitizerConfig = {
	riskyFields: DEFAULT_RISKY_FIELDS,
	traversal: DEFAULT_TRAVERSAL_CONFIG,
	toolRules: DEFAULT_TOOL_RULES,
	defaultRiskLevel: "medium",
	useTier1Classification: true,
	useTier2Classification: false,
	blockHighRisk: false,
	cumulativeRiskThresholds: {
		medium: 3,
		high: 1,
		patterns: 3,
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
 * 5. Optionally classifying with Tier 2 MLP classifier
 * 6. Applying appropriate sanitization methods
 * 7. Tracking cumulative risk for fragmented attack detection
 */
export class ToolResultSanitizer {
	private config: ToolResultSanitizerConfig;
	private sanitizer: Sanitizer;
	private patternDetector: PatternDetector;
	private tier2Classifier: Tier2Classifier | null = null;

	constructor(config: Partial<ToolResultSanitizerConfig> = {}) {
		this.config = { ...DEFAULT_TOOL_RESULT_SANITIZER_CONFIG, ...config };
		this.sanitizer = createSanitizer();
		this.patternDetector = createPatternDetector();

		// Initialize Tier 2 classifier if enabled
		if (this.config.useTier2Classification) {
			this.tier2Classifier = createTier2Classifier(this.config.tier2Config);
			if (this.config.tier2Weights) {
				this.tier2Classifier.loadWeights(this.config.tier2Weights);
			}
		}
	}

	/**
	 * Load MLP weights for Tier 2 classification
	 * Call this after construction if weights weren't provided in config
	 */
	loadTier2Weights(weights: MLPWeights): void {
		if (!this.tier2Classifier) {
			this.tier2Classifier = createTier2Classifier(this.config.tier2Config);
		}
		this.tier2Classifier.loadWeights(weights);
	}

	/**
	 * Pre-load the Tier 2 embedding model
	 * Call this at startup to avoid latency on first sanitizeAsync() call
	 */
	async warmupTier2(): Promise<void> {
		if (this.tier2Classifier) {
			await this.tier2Classifier.warmup();
		}
	}

	/**
	 * Check if Tier 2 is ready (weights loaded)
	 */
	isTier2Ready(): boolean {
		return this.tier2Classifier?.isReady() ?? false;
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

		// Generate boundary for this result
		const boundary = options.boundary ?? generateDataBoundary();

		// Get tool-specific rule
		const toolRule = getToolRule(options.toolName, this.config.toolRules);

		// Initialize cumulative risk tracker
		const cumulativeRisk = this.createCumulativeRiskTracker(toolRule);

		// Initialize size metrics
		const sizeMetrics = createSizeMetrics();

		// Create initial context
		const context: SanitizationContext = {
			path: "",
			fieldName: "",
			toolName: options.toolName,
			vertical: options.vertical ?? this.extractVertical(options.toolName),
			resource: options.resource ?? this.extractResource(options.toolName),
			riskLevel: options.riskLevel ?? toolRule?.sanitizationLevel ?? this.config.defaultRiskLevel,
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
		};

		// Sanitize the value
		const sanitized = this.sanitizeValue(value as SanitizableValue, context, toolRule, metadata, 0);

		// Check if cumulative risk requires escalation
		if (this.shouldEscalate(cumulativeRisk)) {
			metadata.cumulativeRiskEscalated = true;
			metadata.overallRiskLevel = "high";
		}

		metadata.totalLatencyMs = performance.now() - startTime;
		metadata.sizeMetrics = sizeMetrics;

		return {
			sanitized: sanitized as T,
			metadata,
		};
	}

	/**
	 * Sanitize a complete tool result with Tier 2 ML classification
	 *
	 * Use this method when Tier 2 classification is enabled.
	 * Tier 2 uses an MLP classifier with embeddings for more accurate detection.
	 *
	 * @param value - The tool result to sanitize
	 * @param options - Sanitization options
	 * @returns Sanitized result with metadata
	 *
	 * @remarks
	 * When Tier 2 classification is enabled, array/object fields are processed
	 * concurrently for performance. This may cause minor inaccuracies in the
	 * returned metadata (e.g., stringCount, fieldsSanitized) due to concurrent
	 * writes, but does not affect the correctness of the sanitized output.
	 *
	 * For guaranteed metadata precision with Tier 1 only, use sanitize() instead.
	 */
	async sanitizeAsync<T = unknown>(value: T, options: SanitizeToolResultOptions): Promise<SanitizationResult<T>> {
		const startTime = performance.now();

		// Generate boundary for this result
		const boundary = options.boundary ?? generateDataBoundary();

		// Get tool-specific rule
		const toolRule = getToolRule(options.toolName, this.config.toolRules);

		// Initialize cumulative risk tracker
		const cumulativeRisk = this.createCumulativeRiskTracker(toolRule);

		// Initialize size metrics
		const sizeMetrics = createSizeMetrics();

		// Create initial context
		const context: SanitizationContext = {
			path: "",
			fieldName: "",
			toolName: options.toolName,
			vertical: options.vertical ?? this.extractVertical(options.toolName),
			resource: options.resource ?? this.extractResource(options.toolName),
			riskLevel: options.riskLevel ?? toolRule?.sanitizationLevel ?? this.config.defaultRiskLevel,
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
		};

		// Sanitize the value with async support for Tier 2
		const sanitized = await this.sanitizeValueAsync(value as SanitizableValue, context, toolRule, metadata, 0);

		// Check if cumulative risk requires escalation
		if (this.shouldEscalate(cumulativeRisk)) {
			metadata.cumulativeRiskEscalated = true;
			metadata.overallRiskLevel = "high";
		}

		metadata.totalLatencyMs = performance.now() - startTime;
		metadata.sizeMetrics = sizeMetrics;

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
		toolRule: ToolSanitizationRule | undefined,
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
			return this.sanitizeArray(value, context, toolRule, metadata, depth);
		}

		// Handle objects
		if (typeof value === "object") {
			return this.sanitizeObject(value as Record<string, SanitizableValue>, context, toolRule, metadata, depth);
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
		toolRule: ToolSanitizationRule | undefined,
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
				sanitized.push(this.sanitizeValue(arr[i], itemContext, toolRule, metadata, depth + 1));
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
			return this.sanitizeValue(item, itemContext, toolRule, metadata, depth + 1);
		});
	}

	/**
	 * Sanitize an object
	 */
	private sanitizeObject(
		obj: Record<string, SanitizableValue>,
		context: SanitizationContext,
		toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
		depth: number,
	): Record<string, SanitizableValue> {
		metadata.sizeMetrics.objectCount++;

		// Check for paginated response
		if (isPaginatedResponse(obj)) {
			return this.sanitizePaginatedResponse(obj, context, toolRule, metadata, depth);
		}

		// Check for wrapped response
		const structureType = detectStructureType(obj);
		if (structureType === "wrapped") {
			return this.sanitizeWrappedResponse(obj, context, toolRule, metadata, depth);
		}

		// Regular object - process each field
		const result: Record<string, SanitizableValue> = {};

		for (const [key, val] of Object.entries(obj)) {
			const fieldPath = context.path ? `${context.path}.${key}` : key;
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			// Check if field should be skipped
			if (shouldSkipField(key, toolRule)) {
				result[key] = val;
				continue;
			}

			// Check if this is a risky field that needs sanitization
			if (this.isFieldRisky(key, context.toolName) && typeof val === "string") {
				result[key] = this.sanitizeStringField(val, fieldContext, toolRule, metadata);
			} else {
				// Recurse into non-risky fields
				result[key] = this.sanitizeValue(val, fieldContext, toolRule, metadata, depth + 1);
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
		toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
		depth: number,
	): Record<string, SanitizableValue> {
		const result: Record<string, SanitizableValue> = { ...obj };

		// Find and sanitize the data array
		const dataKeys = ["data", "results", "items", "records"];
		for (const key of dataKeys) {
			if (Array.isArray(obj[key])) {
				const dataContext = {
					...context,
					path: `${context.path}.${key}`,
				};
				result[key] = this.sanitizeArray(
					obj[key] as SanitizableValue[],
					dataContext,
					toolRule,
					metadata,
					depth + 1,
				);
				break;
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
		toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
		depth: number,
	): Record<string, SanitizableValue> {
		const result: Record<string, SanitizableValue> = {};

		for (const [key, val] of Object.entries(obj)) {
			const fieldPath = context.path ? `${context.path}.${key}` : key;
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			// Check if this is the data wrapper
			const wrappedData = getWrappedData({ [key]: val });
			if (wrappedData) {
				result[key] = this.sanitizeArray(
					val as SanitizableValue[],
					fieldContext,
					toolRule,
					metadata,
					depth + 1,
				);
			} else {
				result[key] = this.sanitizeValue(val, fieldContext, toolRule, metadata, depth + 1);
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
		_toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
	): string {
		metadata.sizeMetrics.stringCount++;

		// Determine risk level for this field
		let riskLevel = context.riskLevel;

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

				// Update cumulative risk tracker
				if (context.cumulativeRisk) {
					this.updateCumulativeRisk(context.cumulativeRisk, riskLevel, tier1Patterns);
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
	// Async Methods (for Tier 2 classification)
	// ==========================================================================

	/**
	 * Recursively sanitize a value (async version for Tier 2)
	 */
	private async sanitizeValueAsync(
		value: SanitizableValue,
		context: SanitizationContext,
		toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
		depth: number,
	): Promise<SanitizableValue> {
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
			return this.sanitizeArrayAsync(value, context, toolRule, metadata, depth);
		}

		// Handle objects
		if (typeof value === "object") {
			return this.sanitizeObjectAsync(
				value as Record<string, SanitizableValue>,
				context,
				toolRule,
				metadata,
				depth,
			);
		}

		// Primitives (non-string) pass through
		return value;
	}

	/**
	 * Sanitize an array (async version)
	 */
	private async sanitizeArrayAsync(
		arr: SanitizableValue[],
		context: SanitizationContext,
		toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
		depth: number,
	): Promise<SanitizableValue[]> {
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
				sanitized.push(await this.sanitizeValueAsync(arr[i], itemContext, toolRule, metadata, depth + 1));
			}

			// Add notice about skipped items
			if (arr.length > sampleSize) {
				sanitized.push(`[${arr.length - sampleSize} more items - sanitization skipped for performance]`);
			}

			return sanitized;
		}

		// Sanitize all items concurrently
		// NOTE: Concurrent execution may result in race conditions when writing to shared
		// metadata (fieldsSanitized array, sizeMetrics counters). This affects reporting
		// accuracy but does not compromise the correctness of the sanitized output.
		// For precise metadata, use the synchronous sanitize() method with Tier 1 only.
		const promises = arr.map((item, index) => {
			const itemContext = {
				...context,
				path: `${context.path}[${index}]`,
			};
			return this.sanitizeValueAsync(item, itemContext, toolRule, metadata, depth + 1);
		});
		return Promise.all(promises);
	}

	/**
	 * Sanitize an object (async version)
	 */
	private async sanitizeObjectAsync(
		obj: Record<string, SanitizableValue>,
		context: SanitizationContext,
		toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
		depth: number,
	): Promise<Record<string, SanitizableValue>> {
		metadata.sizeMetrics.objectCount++;

		// Check for paginated response
		if (isPaginatedResponse(obj)) {
			return this.sanitizePaginatedResponseAsync(obj, context, toolRule, metadata, depth);
		}

		// Check for wrapped response
		const structureType = detectStructureType(obj);
		if (structureType === "wrapped") {
			return this.sanitizeWrappedResponseAsync(obj, context, toolRule, metadata, depth);
		}

		// Regular object - process each field concurrently
		const result: Record<string, SanitizableValue> = {};
		const entries = Object.entries(obj);

		// Separate skipped fields from fields that need processing
		const skippedFields: [string, SanitizableValue][] = [];
		const fieldsToProcess: Array<{
			key: string;
			val: SanitizableValue;
			fieldContext: SanitizationContext;
		}> = [];

		for (const [key, val] of entries) {
			const fieldPath = context.path ? `${context.path}.${key}` : key;
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			// Check if field should be skipped
			if (shouldSkipField(key, toolRule)) {
				skippedFields.push([key, val]);
			} else {
				fieldsToProcess.push({ key, val, fieldContext });
			}
		}

		// Add skipped fields immediately
		for (const [key, val] of skippedFields) {
			result[key] = val;
		}

		// Process remaining fields concurrently
		// NOTE: Concurrent metadata writes may cause undercounting in sizeMetrics and
		// fieldsSanitized due to race conditions. This is an acceptable tradeoff for
		// the 10-100x latency improvement from parallel Tier 2 classification.
		const promises = fieldsToProcess.map(async ({ key, val, fieldContext }) => {
			let sanitizedValue: SanitizableValue;

			// Check if this is a risky field that needs sanitization
			if (this.isFieldRisky(key, context.toolName) && typeof val === "string") {
				sanitizedValue = await this.sanitizeStringFieldAsync(val, fieldContext, toolRule, metadata);
			} else {
				// Recurse into non-risky fields
				sanitizedValue = await this.sanitizeValueAsync(val, fieldContext, toolRule, metadata, depth + 1);
			}

			return { key, sanitizedValue };
		});

		const results = await Promise.all(promises);
		for (const { key, sanitizedValue } of results) {
			result[key] = sanitizedValue;
		}

		return result;
	}

	/**
	 * Sanitize a paginated response (async version)
	 */
	private async sanitizePaginatedResponseAsync(
		obj: Record<string, SanitizableValue>,
		context: SanitizationContext,
		toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
		depth: number,
	): Promise<Record<string, SanitizableValue>> {
		const result: Record<string, SanitizableValue> = { ...obj };

		// Find and sanitize the data array
		const dataKeys = ["data", "results", "items", "records"];
		for (const key of dataKeys) {
			if (Array.isArray(obj[key])) {
				const dataContext = {
					...context,
					path: `${context.path}.${key}`,
				};
				result[key] = await this.sanitizeArrayAsync(
					obj[key] as SanitizableValue[],
					dataContext,
					toolRule,
					metadata,
					depth + 1,
				);
				break;
			}
		}

		return result;
	}

	/**
	 * Sanitize a wrapped response (async version)
	 */
	private async sanitizeWrappedResponseAsync(
		obj: Record<string, SanitizableValue>,
		context: SanitizationContext,
		toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
		depth: number,
	): Promise<Record<string, SanitizableValue>> {
		const result: Record<string, SanitizableValue> = {};

		for (const [key, val] of Object.entries(obj)) {
			const fieldPath = context.path ? `${context.path}.${key}` : key;
			const fieldContext = {
				...context,
				path: fieldPath,
				fieldName: key,
			};

			// Check if this is the data wrapper
			const wrappedData = getWrappedData({ [key]: val });
			if (wrappedData) {
				result[key] = await this.sanitizeArrayAsync(
					val as SanitizableValue[],
					fieldContext,
					toolRule,
					metadata,
					depth + 1,
				);
			} else {
				result[key] = await this.sanitizeValueAsync(val, fieldContext, toolRule, metadata, depth + 1);
			}
		}

		return result;
	}

	/**
	 * Sanitize a string field with Tier 2 classification
	 */
	private async sanitizeStringFieldAsync(
		value: string,
		context: SanitizationContext,
		_toolRule: ToolSanitizationRule | undefined,
		metadata: SanitizationMetadata,
	): Promise<string> {
		metadata.sizeMetrics.stringCount++;

		// Determine risk level for this field
		let riskLevel = context.riskLevel;

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

				// Update cumulative risk tracker
				if (context.cumulativeRisk) {
					this.updateCumulativeRisk(context.cumulativeRisk, riskLevel, tier1Patterns);
				}
			}
		}

		// Use Tier 2 classification if enabled and classifier is available
		if (
			this.config.useTier2Classification &&
			this.tier2Classifier &&
			riskLevel !== "critical" // Skip Tier 2 if already critical
		) {
			const tier2Result = await this.tier2Classifier.classify(value);

			if (!tier2Result.skipped) {
				const tier2RiskLevel = this.tier2Classifier.getRiskLevel(tier2Result.score);

				// Tier 2 can escalate risk but not reduce it
				// Note: riskLevel cannot be 'critical' here (filtered by outer condition)
				if (tier2RiskLevel === "high") {
					riskLevel = "high";
					if (context.cumulativeRisk) {
						this.updateCumulativeRisk(context.cumulativeRisk, riskLevel, ["tier2_high_score"]);
					}
				} else if (tier2RiskLevel === "medium" && riskLevel === "low") {
					riskLevel = "medium";
					if (context.cumulativeRisk) {
						this.updateCumulativeRisk(context.cumulativeRisk, riskLevel, ["tier2_medium_score"]);
					}
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
	 * Create cumulative risk tracker with tool-specific thresholds
	 */
	private createCumulativeRiskTracker(toolRule?: ToolSanitizationRule): CumulativeRiskTracker {
		const thresholds = toolRule?.cumulativeRiskThresholds ?? this.config.cumulativeRiskThresholds;
		return {
			mediumRiskCount: 0,
			highRiskCount: 0,
			suspiciousPatterns: [],
			totalFieldsProcessed: 0,
			escalationThreshold: {
				medium: thresholds.medium,
				high: thresholds.high,
				patterns: thresholds.patterns,
			},
		};
	}

	/**
	 * Update cumulative risk tracker
	 */
	private updateCumulativeRisk(tracker: CumulativeRiskTracker, riskLevel: RiskLevel, patterns: string[]): void {
		tracker.totalFieldsProcessed++;

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
		if (tracker.highRiskCount >= tracker.escalationThreshold.high) {
			return true;
		}
		if (tracker.mediumRiskCount >= tracker.escalationThreshold.medium) {
			return true;
		}
		if (tracker.suspiciousPatterns.length >= tracker.escalationThreshold.patterns) {
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
