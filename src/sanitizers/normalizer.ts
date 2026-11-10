import { normalizeLeetSpeak } from "./leet-normalizer";

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

		// ANSI escapes and C0 control characters (not tab, LF, CR). A space, not "": they are
		// spliced in place of spaces ("ignore<ESC>all") to break \s+ patterns.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
		[/\x1B\[[0-9;?]*[A-Za-z]|\x1B[@-_]|[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " "],

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

	return joinLineSplitWords(collapseSpacedLetters(text));
}

/** Collapse letter-by-letter spacing: "S Y S T E M" → "SYSTEM" (3+ single letters, one space apart). */
export function collapseSpacedLetters(text: string): string {
	if (!text) return text;
	return text.replace(/\b([a-zA-Z] ){2,}[a-zA-Z]\b/g, (match) => match.replace(/ /g, ""));
}

/**
 * Remove line breaks between adjacent letters ("ign\nore" → "ignore"). Tier 1 only: it also
 * joins the words of ordinary multi-line text, which would hurt Tier 2's scoring.
 * \s* is intentionally omitted: consuming surrounding spaces would destroy word boundaries.
 */
export function joinLineSplitWords(text: string): string {
	if (!text) return text;
	return text.replace(/([a-zA-Z])[\r\n]+([a-zA-Z])/g, "$1$2");
}

// Greek and Cyrillic letters that look like Latin ones, and their Latin letter (the 8
// common Cyrillic ones are mapped unconditionally in normalizeUnicode).
const CONFUSABLE_FROM = "αγεικνορτυχωϲϳΑΒΕΖΗΙΚΜΝΟΡΤΥΧјѕԁһӏԛԝкАВЕКМНОРСТХУІЈЅıɡɑ";
const CONFUSABLE_TO = "ayeikvoptuxwcjABEZHIKMNOPTYXjsdhlqwkABEKMHOPCTXYIJSiga";
const CONFUSABLES = new Map(Array.from(CONFUSABLE_FROM, (c, i) => [c, CONFUSABLE_TO[i]]));
const CONFUSABLE_RE = new RegExp(`[${CONFUSABLE_FROM}]`, "u");
const GREEK_CYRILLIC_RE = /[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F]/gu;

/**
 * Fold Greek/Cyrillic look-alikes to Latin. Only inside words that also hold a Latin
 * letter, or anywhere when the text has no Greek/Cyrillic letter without a Latin
 * look-alike, so real Greek or Russian text is left alone.
 */
export function foldConfusables(text: string): string {
	if (!text || !CONFUSABLE_RE.test(text)) return text;
	const nativeScript = (text.match(GREEK_CYRILLIC_RE) ?? []).some((c) => !CONFUSABLES.has(c));
	return text.replace(/[\p{L}\p{N}]+/gu, (word) => {
		if (!CONFUSABLE_RE.test(word) || (nativeScript && !/[A-Za-z]/.test(word))) return word;
		return Array.from(word, (c) => CONFUSABLES.get(c) ?? c).join("");
	});
}

// 3+ single characters split by one space . - or _ ("i.g n-o r.e").
const SPACED_CHARS_RE = /(?<![A-Za-z0-9@$])[A-Za-z0-9@$](?:[ ._-][A-Za-z0-9@$]){2,}(?![A-Za-z0-9@$])/g;

/**
 * Join a run of spaced-out characters when 3+ are letters. With one punctuation mark
 * ("I.g.n.o.r.e a.l.l") spaces are word breaks; with several mixed ("i.g n-o r.e")
 * they are part of the scrambling.
 */
function joinSpacedChars(run: string): string {
	if (!/[A-Za-z](.*[A-Za-z]){2}/.test(run)) return run;
	if (new Set(run.replace(/[^._-]/g, "")).size > 1) return run.replace(/[ ._-]/g, "");
	return run
		.split(" ")
		.map((w) => w.replace(/[._-]/g, ""))
		.join(" ");
}

/**
 * Join spaced-out letters ("i.g n-o r.e" → "ignore"), then split runs of 3+ words joined
 * by - _ . / or , ("ignore-previous-instructions", "you.are.now"). Two-word compounds
 * ("well-known"), short abbreviations ("a.m.") and digit-only runs are left alone.
 */
export function normalizeWordSeparators(text: string): string {
	if (!text) return text;
	return text
		.replace(SPACED_CHARS_RE, joinSpacedChars)
		.replace(/(?<![A-Za-z0-9])[A-Za-z0-9]+(?:[-_./,][A-Za-z0-9]+){2,}(?![A-Za-z0-9])/g, (m) => {
			const parts = m.split(/[-_./,]/);
			// Digit-only runs (dates, zero GUIDs, versions) stay as they are.
			return parts.filter((w) => /[A-Za-z]/.test(w)).length < 2 ? m : parts.join(" ");
		});
}

/**
 * The analysis copy both tiers scan: control characters, combining marks, unicode
 * variants, look-alikes, joined words, spaced letters and leet undone. Never returned
 * to callers.
 */
export function normalizeForDetection(text: string): string {
	if (!text) return text;
	return normalizeLeetSpeak(
		collapseSpacedLetters(
			normalizeWordSeparators(foldConfusables(normalizeUnicode(stripCombiningMarks(text.normalize("NFD"))))),
		),
	);
}
