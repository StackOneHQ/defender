/**
 * Tier 1: Pattern Detection
 *
 * Fast, regex-based detection of known injection patterns.
 * Target latency: < 1-2ms per field
 */

import type { PatternMatch, RiskLevel, StructuralFlag, Tier1Result } from "../types";
import { ALL_PATTERNS, containsFilterKeywords, type PatternDefinition } from "./patterns";

/**
 * Configuration for the pattern detector
 */
export interface PatternDetectorConfig {
	/** Whether to use fast keyword pre-filtering */
	useFastFilter: boolean;
	/** Maximum string length to analyze (longer strings are truncated) */
	maxAnalysisLength: number;
	/** Entropy threshold for high-entropy detection */
	entropyThreshold: number;
	/** Minimum length to check for high entropy */
	entropyMinLength: number;
	/** Maximum allowed field length before flagging */
	maxFieldLength: number;
	/** Custom patterns to add */
	customPatterns?: PatternDefinition[];
}

/**
 * Default configuration
 */
export const DEFAULT_DETECTOR_CONFIG: PatternDetectorConfig = {
	useFastFilter: true,
	maxAnalysisLength: 50000,
	entropyThreshold: 4.5, // Bits per character (Base64 is ~6, English is ~4)
	entropyMinLength: 50,
	maxFieldLength: 100000,
};

/**
 * Pattern Detector for Tier 1 classification
 *
 * Performs fast, regex-based detection of known injection patterns,
 * role markers, and structural anomalies.
 */
export class PatternDetector {
	private config: PatternDetectorConfig;
	private patterns: PatternDefinition[];

	private hasCustomPatterns: boolean;

	constructor(config: Partial<PatternDetectorConfig> = {}) {
		this.config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
		this.patterns = [...ALL_PATTERNS, ...(config.customPatterns ?? [])];
		this.hasCustomPatterns = (config.customPatterns?.length ?? 0) > 0;
	}

	/**
	 * Analyze a string for injection patterns
	 *
	 * @param text - Text to analyze
	 * @returns Tier 1 classification result
	 */
	analyze(text: string): Tier1Result {
		const startTime = performance.now();

		// Handle empty or very short text
		if (!text || text.length < 3) {
			return this.createEmptyResult(startTime);
		}

		// Check length BEFORE truncation for structural detection
		const originalLength = text.length;

		// Truncate very long text for performance (pattern matching only)
		const analysisText =
			text.length > this.config.maxAnalysisLength ? text.slice(0, this.config.maxAnalysisLength) : text;

		// Fast filter: skip expensive regex if no keywords found
		// Disable fast filter when custom patterns are provided
		const shouldUseFastFilter = this.config.useFastFilter && !this.hasCustomPatterns;
		if (shouldUseFastFilter && !containsFilterKeywords(analysisText)) {
			// Still check structural issues even without keyword matches
			const structuralFlags = this.detectStructuralIssues(analysisText, originalLength);
			return this.createResult([], structuralFlags, startTime);
		}

		// Run pattern matching
		const matches = this.detectPatterns(analysisText);

		// Detect structural issues (pass original length for accurate length check)
		const structuralFlags = this.detectStructuralIssues(analysisText, originalLength);

		return this.createResult(matches, structuralFlags, startTime);
	}

	/**
	 * Detect patterns in text
	 */
	private detectPatterns(text: string): PatternMatch[] {
		const matches: PatternMatch[] = [];

		for (const def of this.patterns) {
			// Clone regex to avoid mutating shared module-level pattern state
			const pattern = new RegExp(def.pattern.source, def.pattern.flags);

			let match: RegExpExecArray | null;

			// Handle global vs non-global patterns
			if (pattern.global) {
				while ((match = pattern.exec(text)) !== null) {
					matches.push({
						pattern: def.id,
						matched: match[0],
						position: match.index,
						category: def.category,
						severity: def.severity,
					});

					// Safety: prevent infinite loops on zero-length matches
					if (match.index === pattern.lastIndex) {
						pattern.lastIndex++;
					}
				}
			} else {
				match = pattern.exec(text);
				if (match) {
					matches.push({
						pattern: def.id,
						matched: match[0],
						position: match.index,
						category: def.category,
						severity: def.severity,
					});
				}
			}
		}

		return matches;
	}

	/**
	 * Detect structural issues in text
	 */
	private detectStructuralIssues(text: string, originalLength?: number): StructuralFlag[] {
		const flags: StructuralFlag[] = [];

		// Check for excessive length (use original length if provided)
		const lengthToCheck = originalLength ?? text.length;
		if (lengthToCheck > this.config.maxFieldLength) {
			flags.push({
				type: "excessive_length",
				details: `Field length ${lengthToCheck} exceeds maximum ${this.config.maxFieldLength}`,
				severity: "medium",
			});
		}

		// Check for high entropy (potential encoded data)
		if (text.length >= this.config.entropyMinLength) {
			const entropy = this.calculateEntropy(text);
			if (entropy > this.config.entropyThreshold) {
				flags.push({
					type: "high_entropy",
					details: `Entropy ${entropy.toFixed(2)} exceeds threshold ${this.config.entropyThreshold}`,
					severity: "medium",
				});
			}
		}

		// Check for suspicious formatting (nested XML/brackets)
		if (this.hasNestedMarkers(text)) {
			flags.push({
				type: "nested_markers",
				details: "Suspicious nested XML tags or bracket patterns detected",
				severity: "medium",
			});
		}

		// Check for suspicious formatting patterns
		if (this.hasSuspiciousFormatting(text)) {
			flags.push({
				type: "suspicious_formatting",
				details: "Unusual formatting patterns detected",
				severity: "low",
			});
		}

		return flags;
	}

	/**
	 * Calculate Shannon entropy of a string
	 * Higher entropy indicates more randomness (potential encoding)
	 */
	private calculateEntropy(text: string): number {
		const freq: Record<string, number> = {};

		for (const char of text) {
			freq[char] = (freq[char] || 0) + 1;
		}

		let entropy = 0;
		const len = text.length;

		for (const count of Object.values(freq)) {
			const p = count / len;
			entropy -= p * Math.log2(p);
		}

		return entropy;
	}

	/**
	 * Check for nested XML tags or bracket patterns
	 */
	private hasNestedMarkers(text: string): boolean {
		// Check for XML-like tags that look like role/instruction markers
		const suspiciousXmlPattern = /<\/?(?:system|user|assistant|instruction|prompt|admin|developer)[^>]*>/gi;
		const suspiciousTags = text.match(suspiciousXmlPattern);
		if (suspiciousTags && suspiciousTags.length >= 2) {
			return true;
		}

		// Check for multiple XML-like tags (any kind)
		const xmlTags = text.match(/<[a-zA-Z][^>]*>/g);
		if (xmlTags && xmlTags.length > 4) {
			// Check if they look like role/instruction markers
			const markerTags = xmlTags.filter((tag) => /system|user|assistant|instruction|prompt/i.test(tag));
			if (markerTags.length > 0) {
				return true;
			}
		}

		// Check for nested brackets with suspicious content
		const bracketPattern = /\[\[.*?(system|instruction|ignore).*?\]\]/i;
		if (bracketPattern.test(text)) {
			return true;
		}

		return false;
	}

	/**
	 * Check for suspicious formatting patterns
	 */
	private hasSuspiciousFormatting(text: string): boolean {
		// Multiple newlines followed by what looks like instructions
		const multiNewlineInstruction = /\n{3,}(system|instruction|ignore|forget)/i;
		if (multiNewlineInstruction.test(text)) {
			return true;
		}

		// Markdown-style headers that look like instructions
		const markdownHeader = /^#{1,3}\s*(system|instruction|new rules)/im;
		if (markdownHeader.test(text)) {
			return true;
		}

		// Horizontal rules followed by instruction-like content
		const hrInstruction = /[-=]{3,}\s*\n\s*(system|instruction|ignore)/i;
		if (hrInstruction.test(text)) {
			return true;
		}

		return false;
	}

	/**
	 * Create a Tier1Result from matches and flags
	 */
	private createResult(matches: PatternMatch[], structuralFlags: StructuralFlag[], startTime: number): Tier1Result {
		const hasDetections = matches.length > 0 || structuralFlags.length > 0;

		return {
			matches,
			structuralFlags,
			hasDetections,
			suggestedRisk: this.calculateSuggestedRisk(matches, structuralFlags),
			latencyMs: performance.now() - startTime,
		};
	}

	/**
	 * Create an empty result for short-circuit cases
	 */
	private createEmptyResult(startTime: number): Tier1Result {
		return {
			matches: [],
			structuralFlags: [],
			hasDetections: false,
			suggestedRisk: "low",
			latencyMs: performance.now() - startTime,
		};
	}

	/**
	 * Calculate suggested risk level based on matches and flags
	 */
	private calculateSuggestedRisk(matches: PatternMatch[], structuralFlags: StructuralFlag[]): RiskLevel {
		// Count by severity
		const highMatches = matches.filter((m) => m.severity === "high").length;
		const mediumMatches = matches.filter((m) => m.severity === "medium").length;
		const highFlags = structuralFlags.filter((f) => f.severity === "high").length;
		const mediumFlags = structuralFlags.filter((f) => f.severity === "medium").length;

		// Risk calculation
		if (highMatches >= 2 || (highMatches >= 1 && highFlags >= 1)) {
			return "critical";
		}

		if (highMatches >= 1 || mediumMatches >= 3 || (mediumMatches >= 2 && mediumFlags >= 1)) {
			return "high";
		}

		if (mediumMatches >= 1 || highFlags >= 1 || mediumFlags >= 2) {
			return "medium";
		}

		if (matches.length > 0 || structuralFlags.length > 0) {
			return "low";
		}

		return "low";
	}

	/**
	 * Add custom patterns at runtime
	 */
	addPattern(pattern: PatternDefinition): void {
		this.patterns.push(pattern);
	}

	/**
	 * Get all registered patterns
	 */
	getPatterns(): PatternDefinition[] {
		return [...this.patterns];
	}
}

/**
 * Create a default pattern detector instance
 */
export function createPatternDetector(config?: Partial<PatternDetectorConfig>): PatternDetector {
	return new PatternDetector(config);
}
