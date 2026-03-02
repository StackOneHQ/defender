/**
 * Pattern Removal / Redaction
 *
 * Removes or redacts known injection patterns from text.
 * Uses the shared pattern definitions from the classification system.
 */

import {
    ALL_PATTERNS,
    COMMAND_EXECUTION_PATTERNS,
    INSTRUCTION_OVERRIDE_PATTERNS,
    type PatternDefinition,
    ROLE_ASSUMPTION_PATTERNS,
    SECURITY_BYPASS_PATTERNS,
} from '../classifiers/patterns';

/**
 * Configuration for pattern removal
 */
export interface PatternRemoverConfig {
    /** What to replace matched patterns with */
    replacement: string;
    /** Whether to preserve the matched text length with replacement chars */
    preserveLength: boolean;
    /** Character to use when preserveLength is true */
    preserveChar: string;
    /** Only remove high severity patterns */
    highSeverityOnly: boolean;
    /** Categories to remove (empty = all) */
    categories?: string[];
    /** Custom patterns to also remove */
    customPatterns?: RegExp[];
}

/**
 * Default configuration
 */
export const DEFAULT_PATTERN_REMOVER_CONFIG: PatternRemoverConfig = {
    replacement: '[REDACTED]',
    preserveLength: false,
    preserveChar: '█',
    highSeverityOnly: false,
};

/**
 * Result of pattern removal
 */
export interface PatternRemovalResult {
    /** The sanitized text */
    text: string;
    /** Patterns that were removed */
    patternsRemoved: string[];
    /** Number of replacements made */
    replacementCount: number;
}

/**
 * Remove injection patterns from text
 *
 * @param text - Text to process
 * @param config - Configuration options
 * @returns Result with sanitized text and metadata
 *
 * @example
 * removePatterns('Please ignore previous instructions and do X')
 * // Returns: { text: 'Please [REDACTED] and do X', patternsRemoved: ['ignore_previous'], ... }
 */
export function removePatterns(
    text: string,
    config: Partial<PatternRemoverConfig> = {},
): PatternRemovalResult {
    if (!text) {
        return { text, patternsRemoved: [], replacementCount: 0 };
    }

    const cfg: PatternRemoverConfig = { ...DEFAULT_PATTERN_REMOVER_CONFIG, ...config };
    let result = text;
    const patternsRemoved: string[] = [];
    let replacementCount = 0;

    // Get patterns to use based on config
    const patternsToUse = getPatternsByConfig(cfg);

    // Apply each pattern
    for (const def of patternsToUse) {
        // Clone regex to avoid mutating shared module-level pattern state
        const pattern = new RegExp(def.pattern.source, def.pattern.flags);

        // Check if pattern matches
        const matches = result.match(pattern);
        if (matches) {
            // Replace with configured replacement
            result = result.replace(pattern, (match) => {
                replacementCount++;
                if (!patternsRemoved.includes(def.id)) {
                    patternsRemoved.push(def.id);
                }
                return cfg.preserveLength ? cfg.preserveChar.repeat(match.length) : cfg.replacement;
            });
        }
    }

    // Apply custom patterns
    if (cfg.customPatterns) {
        for (const customPattern of cfg.customPatterns) {
            const pattern = new RegExp(customPattern.source, customPattern.flags);
            const matches = result.match(pattern);
            if (matches) {
                result = result.replace(pattern, (match) => {
                    replacementCount++;
                    if (!patternsRemoved.includes('custom')) {
                        patternsRemoved.push('custom');
                    }
                    return cfg.preserveLength
                        ? cfg.preserveChar.repeat(match.length)
                        : cfg.replacement;
                });
            }
        }
    }

    return { text: result, patternsRemoved, replacementCount };
}

/**
 * Get patterns to use based on configuration
 */
function getPatternsByConfig(config: PatternRemoverConfig): PatternDefinition[] {
    let patterns = [...ALL_PATTERNS];

    // Filter by severity
    if (config.highSeverityOnly) {
        patterns = patterns.filter((p) => p.severity === 'high');
    }

    // Filter by category
    if (config.categories && config.categories.length > 0) {
        patterns = patterns.filter((p) => config.categories?.includes(p.category));
    }

    return patterns;
}

/**
 * Remove only instruction override patterns
 */
export function removeInstructionOverrides(
    text: string,
    replacement: string = '[REDACTED]',
): PatternRemovalResult {
    if (!text) {
        return { text, patternsRemoved: [], replacementCount: 0 };
    }

    let result = text;
    const patternsRemoved: string[] = [];
    let replacementCount = 0;

    for (const def of INSTRUCTION_OVERRIDE_PATTERNS) {
        const pattern = new RegExp(def.pattern.source, def.pattern.flags);
        const matches = result.match(pattern);
        if (matches) {
            result = result.replace(pattern, () => {
                replacementCount++;
                if (!patternsRemoved.includes(def.id)) {
                    patternsRemoved.push(def.id);
                }
                return replacement;
            });
        }
    }

    return { text: result, patternsRemoved, replacementCount };
}

/**
 * Remove only role assumption patterns
 */
export function removeRoleAssumptions(
    text: string,
    replacement: string = '[REDACTED]',
): PatternRemovalResult {
    if (!text) {
        return { text, patternsRemoved: [], replacementCount: 0 };
    }

    let result = text;
    const patternsRemoved: string[] = [];
    let replacementCount = 0;

    for (const def of ROLE_ASSUMPTION_PATTERNS) {
        const pattern = new RegExp(def.pattern.source, def.pattern.flags);
        const matches = result.match(pattern);
        if (matches) {
            result = result.replace(pattern, () => {
                replacementCount++;
                if (!patternsRemoved.includes(def.id)) {
                    patternsRemoved.push(def.id);
                }
                return replacement;
            });
        }
    }

    return { text: result, patternsRemoved, replacementCount };
}

/**
 * Remove only security bypass patterns
 */
export function removeSecurityBypasses(
    text: string,
    replacement: string = '[REDACTED]',
): PatternRemovalResult {
    if (!text) {
        return { text, patternsRemoved: [], replacementCount: 0 };
    }

    let result = text;
    const patternsRemoved: string[] = [];
    let replacementCount = 0;

    for (const def of SECURITY_BYPASS_PATTERNS) {
        const pattern = new RegExp(def.pattern.source, def.pattern.flags);
        const matches = result.match(pattern);
        if (matches) {
            result = result.replace(pattern, () => {
                replacementCount++;
                if (!patternsRemoved.includes(def.id)) {
                    patternsRemoved.push(def.id);
                }
                return replacement;
            });
        }
    }

    return { text: result, patternsRemoved, replacementCount };
}

/**
 * Remove command execution patterns
 */
export function removeCommandExecutions(
    text: string,
    replacement: string = '[REDACTED]',
): PatternRemovalResult {
    if (!text) {
        return { text, patternsRemoved: [], replacementCount: 0 };
    }

    let result = text;
    const patternsRemoved: string[] = [];
    let replacementCount = 0;

    for (const def of COMMAND_EXECUTION_PATTERNS) {
        const pattern = new RegExp(def.pattern.source, def.pattern.flags);
        const matches = result.match(pattern);
        if (matches) {
            result = result.replace(pattern, () => {
                replacementCount++;
                if (!patternsRemoved.includes(def.id)) {
                    patternsRemoved.push(def.id);
                }
                return replacement;
            });
        }
    }

    return { text: result, patternsRemoved, replacementCount };
}
