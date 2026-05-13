/**
 * Composite Sanitizer
 *
 * Risk-based sanitization that combines multiple methods based on risk level.
 * This is the main entry point for sanitizing text content.
 */

import type { DataBoundary, FieldSanitizationResult, RiskLevel, SanitizationMethod } from "../types";
import { generateDataBoundary, wrapWithBoundary } from "../utils/boundary";
import { containsSuspiciousEncoding, containsSuspiciousEncodingDeep, redactAllEncoding } from "./encoding-detector";
import { normalizeLeetSpeak } from "./leet-normalizer";
import { containsSuspiciousUnicode, normalizeUnicode, normalizeWhitespace, stripCombiningMarks } from "./normalizer";
import { removePatterns } from "./pattern-remover";
import { containsRoleMarkers, stripRoleMarkers } from "./role-stripper";

/**
 * Configuration for the composite sanitizer
 */
export interface SanitizerConfig {
	/** Whether to always apply Unicode normalization */
	alwaysNormalize: boolean;
	/**
	 * Wrap sanitized content with `[UD-<id>]...[/UD-<id>]` markers so
	 * downstream LLM prompts can distinguish untrusted tool-result data.
	 * When `false`, the risk-based pipeline skips wrapping entirely at all
	 * risk levels. An explicit `methods: ["boundary_annotation"]` in
	 * `SanitizeOptions` still wraps regardless of this flag (escape hatch).
	 * Default: false.
	 */
	annotateBoundary: boolean;
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
	annotateBoundary: false,
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
 * Applies methods additively by risk level. Unicode normalization is
 * gated by `alwaysNormalize` (default `true`); boundary annotation is
 * gated by `annotateBoundary` (default `false`) as a hard on/off switch
 * across all risk levels. Per-level methods gate purely on `riskLevel`:
 *
 *  - Low:      normalize (if `alwaysNormalize`); pass-through otherwise.
 *  - Medium:   + Unicode normalization (always, regardless of flag) +
 *              role-marker stripping + high-severity pattern removal.
 *  - High:     + pattern removal at all severities + encoding detection
 *              and redaction (replaces base64 / hex blocks with
 *              `[ENCODED DATA]`).
 *  - Critical: block entirely — returns `"[CONTENT BLOCKED FOR SECURITY]"`.
 *
 * When `annotateBoundary` is `true`, every non-critical result is wrapped
 * with `[UD-<id>] ... [/UD-<id>]` markers so downstream LLM prompts can
 * distinguish trusted scaffolding from untrusted tool-result content.
 * The boundary id is generated per-call by default; pass `options.boundary`
 * to reuse an existing one.
 *
 * Callers that want wrapping for a specific call without flipping the
 * global flag can pass `methods: ["boundary_annotation"]` in
 * `SanitizeOptions` — explicit method lists bypass the flag.
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
		// NFKC + homoglyphs only — combining marks are NOT stripped here so that
		// benign accented text like "café" survives Sanitizer's returned output.
		if (this.config.alwaysNormalize || riskLevel !== "low") {
			result = normalizeUnicode(result);
			methodsApplied.push("unicode_normalization");
		}

		// Step 1.5: Heavy normalization at HIGH risk only.
		// At high risk Tier 1 has high confidence of an attack. Apply analysis-grade
		// normalisation (combining-mark strip, whitespace collapse, leet-speak decode)
		// BEFORE role stripping and pattern removal, so the obfuscated forms that
		// PatternDetector detected are also redacted by the sanitizer. Without this,
		// detection succeeds but the dangerous content survives in the output.
		// At medium risk we skip this because it would strip accents from benign
		// borderline content (default risk level is "medium" for all fields).
		if (riskLevel === "high") {
			result = normalizeLeetSpeak(normalizeWhitespace(stripCombiningMarks(result.normalize("NFD"))));
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
		// Uses deep multi-level check to catch chained encodings (e.g. base64 of hex).
		// Risk escalation for encoded payloads (ROT13, binary, Morse) is handled
		// upstream in ToolResultSanitizer.sanitizeStringField via containsSuspiciousEncoding.
		if (riskLevel === "high") {
			if (containsSuspiciousEncodingDeep(result)) {
				result = redactAllEncoding(result, this.config.encodingRedactionText);
				methodsApplied.push("encoding_detection");
			}
		}

		// Step 5: Boundary annotation (opt-in hard gate; off by default)
		if (this.config.annotateBoundary) {
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
					// Explicit method request — honored regardless of the
					// `annotateBoundary` config flag (escape hatch for callers
					// that opt into wrapping per-call without flipping the global default).
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
