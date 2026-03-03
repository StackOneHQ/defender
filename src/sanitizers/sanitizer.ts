/**
 * Composite Sanitizer
 *
 * Risk-based sanitization that combines multiple methods based on risk level.
 * This is the main entry point for sanitizing text content.
 */

import type { DataBoundary, FieldSanitizationResult, RiskLevel, SanitizationMethod } from "../types";
import { generateDataBoundary, wrapWithBoundary } from "../utils/boundary";
import { containsSuspiciousEncoding, redactAllEncoding } from "./encoding-detector";
import { containsSuspiciousUnicode, normalizeUnicode } from "./normalizer";
import { removePatterns } from "./pattern-remover";
import { containsRoleMarkers, stripRoleMarkers } from "./role-stripper";

/**
 * Configuration for the composite sanitizer
 */
export interface SanitizerConfig {
	/** Whether to always apply Unicode normalization */
	alwaysNormalize: boolean;
	/** Whether to always wrap with boundaries */
	alwaysAnnotate: boolean;
	/** Default boundary to use (if not provided per-call) */
	defaultBoundary?: DataBoundary;
	/** Replacement text for redacted patterns */
	redactionText: string;
	/** Replacement text for encoded content */
	encodingRedactionText: string;
	/** Whether to include original text in result metadata */
	includeOriginal: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_SANITIZER_CONFIG: SanitizerConfig = {
	alwaysNormalize: true,
	alwaysAnnotate: true,
	redactionText: "[REDACTED]",
	encodingRedactionText: "[ENCODED DATA]",
	includeOriginal: false,
};

/**
 * Options for a single sanitization call
 */
export interface SanitizeOptions {
	/** Risk level to apply */
	riskLevel: RiskLevel;
	/** Boundary to use for annotation (generated if not provided) */
	boundary?: DataBoundary;
	/** Override specific methods to apply */
	methods?: SanitizationMethod[];
	/** Field name (for logging/metadata) */
	fieldName?: string;
}

/**
 * Composite Sanitizer class
 *
 * Applies sanitization methods based on risk level:
 * - Low: Unicode normalization + boundary annotation
 * - Medium: + Role stripping + pattern removal
 * - High: + Encoding detection and redaction
 * - Critical: Block (returns empty or error indicator)
 */
export class Sanitizer {
	private config: SanitizerConfig;

	constructor(config: Partial<SanitizerConfig> = {}) {
		this.config = { ...DEFAULT_SANITIZER_CONFIG, ...config };
	}

	/**
	 * Sanitize a string based on risk level
	 *
	 * @param text - Text to sanitize
	 * @param options - Sanitization options including risk level
	 * @returns Sanitization result with sanitized text and metadata
	 */
	sanitize(text: string, options: SanitizeOptions): FieldSanitizationResult {
		const { riskLevel, boundary, methods } = options;

		// Handle empty/null input
		if (!text) {
			return {
				original: this.config.includeOriginal ? text : "",
				sanitized: text ?? "",
				methodsApplied: [],
				patternsRemoved: [],
				riskLevel,
			};
		}

		// Handle critical risk - block entirely
		if (riskLevel === "critical") {
			return this.blockContent(text, riskLevel);
		}

		// If specific methods are provided, use those
		if (methods && methods.length > 0) {
			return this.applySpecificMethods(text, methods, boundary, riskLevel);
		}

		// Otherwise, apply methods based on risk level
		return this.applyRiskBasedMethods(text, riskLevel, boundary);
	}

	/**
	 * Apply methods based on risk level
	 */
	private applyRiskBasedMethods(
		text: string,
		riskLevel: RiskLevel,
		boundary?: DataBoundary,
	): FieldSanitizationResult {
		let result = text;
		const methodsApplied: SanitizationMethod[] = [];
		const patternsRemoved: string[] = [];

		// Step 1: Unicode normalization (always for medium+ or if configured)
		if (this.config.alwaysNormalize || riskLevel !== "low") {
			result = normalizeUnicode(result);
			methodsApplied.push("unicode_normalization");
		}

		// Step 2: Role stripping (medium and above)
		if (riskLevel === "medium" || riskLevel === "high") {
			if (containsRoleMarkers(result)) {
				result = stripRoleMarkers(result);
				methodsApplied.push("role_stripping");
			}
		}

		// Step 3: Pattern removal (medium and above)
		if (riskLevel === "medium" || riskLevel === "high") {
			const patternResult = removePatterns(result, {
				replacement: this.config.redactionText,
				highSeverityOnly: riskLevel === "medium", // Only high severity for medium risk
			});
			if (patternResult.replacementCount > 0) {
				result = patternResult.text;
				patternsRemoved.push(...patternResult.patternsRemoved);
				methodsApplied.push("pattern_removal");
			}
		}

		// Step 4: Encoding detection (high risk only)
		if (riskLevel === "high") {
			if (containsSuspiciousEncoding(result)) {
				result = redactAllEncoding(result, this.config.encodingRedactionText);
				methodsApplied.push("encoding_detection");
			}
		}

		// Step 5: Boundary annotation (always if configured, or medium+ risk)
		if (this.config.alwaysAnnotate || riskLevel !== "low") {
			const boundaryToUse = boundary ?? this.config.defaultBoundary ?? generateDataBoundary();
			result = wrapWithBoundary(result, boundaryToUse);
			methodsApplied.push("boundary_annotation");
		}

		return {
			original: this.config.includeOriginal ? text : "",
			sanitized: result,
			methodsApplied,
			patternsRemoved,
			riskLevel,
		};
	}

	/**
	 * Apply specific methods regardless of risk level
	 */
	private applySpecificMethods(
		text: string,
		methods: SanitizationMethod[],
		boundary?: DataBoundary,
		riskLevel: RiskLevel = "medium",
	): FieldSanitizationResult {
		let result = text;
		const methodsApplied: SanitizationMethod[] = [];
		const patternsRemoved: string[] = [];

		for (const method of methods) {
			switch (method) {
				case "unicode_normalization":
					result = normalizeUnicode(result);
					methodsApplied.push(method);
					break;

				case "role_stripping":
					result = stripRoleMarkers(result);
					methodsApplied.push(method);
					break;

				case "pattern_removal": {
					const patternResult = removePatterns(result, {
						replacement: this.config.redactionText,
					});
					result = patternResult.text;
					patternsRemoved.push(...patternResult.patternsRemoved);
					methodsApplied.push(method);
					break;
				}

				case "encoding_detection":
					result = redactAllEncoding(result, this.config.encodingRedactionText);
					methodsApplied.push(method);
					break;

				case "boundary_annotation": {
					const boundaryToUse = boundary ?? this.config.defaultBoundary ?? generateDataBoundary();
					result = wrapWithBoundary(result, boundaryToUse);
					methodsApplied.push(method);
					break;
				}
			}
		}

		return {
			original: this.config.includeOriginal ? text : "",
			sanitized: result,
			methodsApplied,
			patternsRemoved,
			riskLevel,
		};
	}

	/**
	 * Block content entirely (for critical risk)
	 */
	private blockContent(text: string, riskLevel: RiskLevel): FieldSanitizationResult {
		return {
			original: this.config.includeOriginal ? text : "",
			sanitized: "[CONTENT BLOCKED FOR SECURITY]",
			methodsApplied: [],
			patternsRemoved: [],
			riskLevel,
		};
	}

	/**
	 * Quick sanitize with default medium risk
	 */
	sanitizeDefault(text: string, boundary?: DataBoundary): FieldSanitizationResult {
		return this.sanitize(text, { riskLevel: "medium", boundary });
	}

	/**
	 * Light sanitization (low risk)
	 */
	sanitizeLight(text: string, boundary?: DataBoundary): FieldSanitizationResult {
		return this.sanitize(text, { riskLevel: "low", boundary });
	}

	/**
	 * Aggressive sanitization (high risk)
	 */
	sanitizeAggressive(text: string, boundary?: DataBoundary): FieldSanitizationResult {
		return this.sanitize(text, { riskLevel: "high", boundary });
	}
}

/**
 * Create a sanitizer with default configuration
 */
export function createSanitizer(config?: Partial<SanitizerConfig>): Sanitizer {
	return new Sanitizer(config);
}

/**
 * Quick sanitize function for one-off use
 */
export function sanitizeText(text: string, riskLevel: RiskLevel = "medium", boundary?: DataBoundary): string {
	const sanitizer = createSanitizer();
	const result = sanitizer.sanitize(text, { riskLevel, boundary });
	return result.sanitized;
}

/**
 * Analyze text and suggest appropriate risk level
 */
export function suggestRiskLevel(text: string): RiskLevel {
	if (!text) return "low";

	let riskScore = 0;

	// Check for suspicious Unicode
	if (containsSuspiciousUnicode(text)) {
		riskScore += 1;
	}

	// Check for role markers
	if (containsRoleMarkers(text)) {
		riskScore += 2;
	}

	// Check for suspicious encoding
	if (containsSuspiciousEncoding(text)) {
		riskScore += 2;
	}

	// Check for injection patterns (quick check)
	const injectionKeywords = [
		"ignore previous",
		"forget instructions",
		"you are now",
		"system:",
		"bypass",
		"jailbreak",
	];
	const lowerText = text.toLowerCase();
	for (const keyword of injectionKeywords) {
		if (lowerText.includes(keyword)) {
			riskScore += 2;
		}
	}

	// Map score to risk level
	if (riskScore >= 6) return "critical";
	if (riskScore >= 4) return "high";
	if (riskScore >= 2) return "medium";
	return "low";
}
