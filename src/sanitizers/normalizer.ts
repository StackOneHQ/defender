/**
 * Unicode Normalization
 *
 * Preprocessing step to normalize Unicode variants to ASCII equivalents.
 * Prevents bypass attacks using mathematical symbols, fullwidth characters, etc.
 */

/**
 * Normalize Unicode text using NFKC normalization
 *
 * NFKC = Compatibility Decomposition + Canonical Composition
 * - Converts mathematical symbols (𝓲𝓰𝓷𝓸𝓻𝓮) to ASCII (ignore)
 * - Converts fullwidth characters (ＳＹＳＴＥＭ) to ASCII (SYSTEM)
 * - Converts other Unicode variants to their canonical forms
 *
 * @param text - Text to normalize
 * @returns Normalized text
 *
 * @example
 * normalizeUnicode('𝓲𝓰𝓷𝓸𝓻𝓮 𝓹𝓻𝓮𝓿𝓲𝓸𝓾𝓼')
 * // Returns: 'ignore previous'
 */
export function normalizeUnicode(text: string): string {
	if (!text) return text;

	// NFKC normalization (fullwidth → ASCII, math alphanumerics → ASCII, etc.)
	// Does NOT strip combining marks — Sanitizer returns this output to callers,
	// so we must preserve legitimate accents like "café" and "niño".
	// Combining-mark stripping (Zalgo defense) lives in stripCombiningMarks() and
	// is only applied in the analysis-only path (PatternDetector.analyze).
	let normalized = text.normalize("NFKC");

	// Additional normalization for common bypass characters
	normalized = normalizeSpecialCharacters(normalized);

	return normalized;
}

/**
 * Strip Unicode combining marks used in Zalgo / diacritical stacking attacks.
 *
 * Attackers stack combining diacritics on base letters to visually obscure
 * keywords while keeping the base character readable (e.g. "ḭ̷g̈n̅o̊r̂e̋" → "ignore").
 * NFKC normalization removes some but not all combining marks; this function
 * strips the residuals across all combining Unicode ranges.
 *
 * Ranges covered:
 *   U+0300–U+036F  Combining Diacritical Marks
 *   U+1AB0–U+1AFF  Combining Diacritical Marks Extended
 *   U+1DC0–U+1DFF  Combining Diacritical Marks Supplement
 *   U+20D0–U+20FF  Combining Diacritical Marks for Symbols
 *   U+FE20–U+FE2F  Combining Half Marks
 *
 * Note: this also strips legitimate accents (é → e, ü → u). The output is
 * used for Tier 1 analysis only and is never returned to callers.
 *
 * @param text - Text to strip
 * @returns Text with combining marks removed
 */
export function stripCombiningMarks(text: string): string {
	if (!text) return text;
	return text.replace(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g, "");
}

/**
 * Normalize special characters often used in bypass attempts
 */
function normalizeSpecialCharacters(text: string): string {
	// Map of special characters to their ASCII equivalents
	const replacements: [RegExp, string][] = [
		// Zero-width characters (invisible)
		[/[\u200B-\u200D\uFEFF]/g, ""], // Zero-width space, joiner, non-joiner, BOM

		// Homoglyphs - characters that look like ASCII but aren't
		[/[\u0430]/g, "a"], // Cyrillic а
		[/[\u0435]/g, "e"], // Cyrillic е
		[/[\u043E]/g, "o"], // Cyrillic о
		[/[\u0440]/g, "p"], // Cyrillic р
		[/[\u0441]/g, "c"], // Cyrillic с
		[/[\u0443]/g, "y"], // Cyrillic у
		[/[\u0445]/g, "x"], // Cyrillic х
		[/[\u0456]/g, "i"], // Cyrillic і

		// Common look-alikes
		[/[\u2018\u2019\u201B\u0060\u00B4]/g, "'"], // Various quotes to apostrophe
		[/[\u201C\u201D\u201E\u201F]/g, '"'], // Various quotes to double quote
		[/[\u2010-\u2015\u2212]/g, "-"], // Various dashes to hyphen
		[/[\u2024]/g, "."], // One dot leader
		[/[\u2026]/g, "..."], // Ellipsis

		// Modifier letters that look like punctuation
		[/[\u02D0]/g, ":"], // Modifier letter triangular colon
		[/[\uA789]/g, ":"], // Modifier letter colon
	];

	let result = text;
	for (const [pattern, replacement] of replacements) {
		result = result.replace(pattern, replacement);
	}

	return result;
}

/**
 * Check if text contains potentially suspicious Unicode
 *
 * @param text - Text to check
 * @returns Whether suspicious Unicode was detected
 */
export function containsSuspiciousUnicode(text: string): boolean {
	if (!text) return false;

	// Check for zero-width characters
	if (/[\u200B-\u200D\uFEFF]/.test(text)) {
		return true;
	}

	// Check for Cyrillic characters mixed with Latin
	const hasCyrillic = /[\u0400-\u04FF]/.test(text);
	const hasLatin = /[a-zA-Z]/.test(text);
	if (hasCyrillic && hasLatin) {
		return true;
	}

	// Check for mathematical alphanumeric symbols
	if (/[\u{1D400}-\u{1D7FF}]/u.test(text)) {
		return true;
	}

	// Check for fullwidth characters
	if (/[\uFF00-\uFFEF]/.test(text)) {
		return true;
	}

	// Check for Zalgo / stacked combining diacritics (3+ is suspicious)
	const combiningCount = (text.match(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/g) ?? [])
		.length;
	if (combiningCount >= 3) {
		return true;
	}

	return false;
}

/**
 * Normalize whitespace obfuscation in text.
 *
 * Handles two common techniques used to split keywords past regex filters:
 *
 * 1. Letter-by-letter spacing — sequences of 3+ single letters separated by
 *    single spaces, e.g. "S Y S T E M" → "SYSTEM", "i g n o r e" → "ignore".
 *    Runs of fewer than 3 letters are left untouched to avoid collapsing
 *    legitimate short words like "I am".
 *
 * 2. Embedded newlines — line breaks inserted inside word runs, e.g.
 *    "ign\nore" → "ignore". Only removed when both neighbours are alphabetic.
 *
 * Note: this function operates on ASCII letters only ([a-zA-Z]). It must be
 * called AFTER normalizeUnicode so that Cyrillic/fullwidth homoglyphs are
 * already resolved to ASCII before whitespace collapse runs.
 *
 * The result is used for Tier 1 analysis only and is never returned to callers.
 *
 * @param text - Text to normalize
 * @returns Text with whitespace obfuscation collapsed
 */
export function normalizeWhitespace(text: string): string {
	if (!text) return text;

	// Collapse letter-by-letter spacing: "S Y S T E M" → "SYSTEM"
	// Match a run of 3+ single letters each separated by exactly one space.
	const result = text.replace(/\b([a-zA-Z] ){2,}[a-zA-Z]\b/g, (match) => match.replace(/ /g, ""));

	// Remove embedded newlines/carriage-returns between immediately adjacent letters.
	// \s* is intentionally omitted: consuming surrounding spaces would silently destroy
	// word-boundary separators (e.g. "ignore\n previous" → "ignoreprevious"), which
	// breaks multi-word pattern matching rather than fixing obfuscation.
	return result.replace(/([a-zA-Z])[\r\n]+([a-zA-Z])/g, "$1$2");
}

/**
 * Get details about suspicious Unicode in text
 *
 * @param text - Text to analyze
 * @returns Object with details about suspicious characters found
 */
export function analyzeSuspiciousUnicode(text: string): {
	hasSuspicious: boolean;
	zeroWidth: boolean;
	mixedScript: boolean;
	mathSymbols: boolean;
	fullwidth: boolean;
} {
	return {
		hasSuspicious: containsSuspiciousUnicode(text),
		zeroWidth: /[\u200B-\u200D\uFEFF]/.test(text),
		mixedScript: /[\u0400-\u04FF]/.test(text) && /[a-zA-Z]/.test(text),
		mathSymbols: /[\u{1D400}-\u{1D7FF}]/u.test(text),
		fullwidth: /[\uFF00-\uFFEF]/.test(text),
	};
}
