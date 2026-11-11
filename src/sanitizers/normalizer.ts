import { type LeetGate, normalizeLeetSpeak } from "./leet-normalizer";

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

/**
 * Split two words joined by - _ or . ("ignore-previous", "ignore__all"). Tier 1 only:
 * its patterns are specific, but Tier 2 would read every compound and hostname apart.
 */
export function splitJoinedWordPairs(text: string): string {
	if (!text) return text;
	return text.replace(/([A-Za-z])[-_.]+(?=[A-Za-z])/g, "$1 ");
}

// Greek and Cyrillic letters that look like Latin ones, and their Latin letter (the 8
// common Cyrillic ones are mapped unconditionally in normalizeUnicode).
const CONFUSABLE_FROM = "αγεικνορτυχωϲϳΑΒΕΖΗΙΚΜΝΟΡΤΥΧјѕԁһӏԛԝкАВЕКМНОРСТХУІЈЅıɡɑ";
const CONFUSABLE_TO = "ayeikvoptuxwcjABEZHIKMNOPTYXjsdhlqwkABEKMHOPCTXYIJSiga";
const CONFUSABLES = new Map(Array.from(CONFUSABLE_FROM, (c, i) => [c, CONFUSABLE_TO[i]]));
const CONFUSABLE_RE = new RegExp(`[${CONFUSABLE_FROM}]`, "u");
const GREEK_CYRILLIC_RE = /[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F]/gu;

const fold = (word: string) => Array.from(word, (c) => CONFUSABLES.get(c) ?? c).join("");

/**
 * Fold Greek/Cyrillic look-alikes to Latin, in words that hold a Latin letter or only
 * look-alikes. Words with any other Greek/Cyrillic letter are real Greek or Russian and
 * are left alone, as are one-letter words ("Ο") in Greek or Russian text.
 */
export function foldConfusables(text: string): string {
	if (!text || !CONFUSABLE_RE.test(text)) return text;
	const isNative = (s: string) => (s.match(GREEK_CYRILLIC_RE) ?? []).some((c) => !CONFUSABLES.has(c));
	const nativeText = isNative(text);
	return text.replace(/[\p{L}\p{N}]+/gu, (word) => {
		if (!CONFUSABLE_RE.test(word) || /[A-Za-z]/.test(word)) return fold(word);
		if (isNative(word) || (nativeText && Array.from(word).length < 2)) return word;
		return fold(word);
	});
}

// 3+ single characters split by one space . - or _ ("i.g.n.o.r.e a-l-l").
const SPACED_CHARS_RE = /(?<![A-Za-z0-9@$])[A-Za-z0-9@$](?:[ ._-][A-Za-z0-9@$]){2,}(?![A-Za-z0-9@$])/g;

/** Join each space-separated part of a spaced-out run when the run has 3+ letters. */
function joinSpacedChars(run: string): string {
	if (!/[A-Za-z](.*[A-Za-z]){2}/.test(run)) return run;
	return run
		.split(" ")
		.map((w) => w.replace(/[._-]/g, ""))
		.join(" ");
}

/**
 * Join spaced-out letters ("i.g.n.o.r.e a-l-l" → "ignore all"), then split runs of 3+ words joined
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

// ANSI escapes (7- and 8-bit) and C0/C1 control characters (not tab, LF, CR). A space,
// not "": they are spliced in place of spaces ("ignore<ESC>all") to break \s+ patterns.
const CONTROL_RE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control chars is the point
	/\x1B\[[0-9;?]*[A-Za-z]|\x9B[0-9;?]*[A-Za-z]|\x1B[@-_]|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
// Invisible format characters normalizeUnicode keeps: soft hyphen, Mongolian vowel
// separator, LRM/RLM, word joiner and invisible operators, variation selectors.
// biome-ignore lint/suspicious/noMisleadingCharacterClass: variation selectors are matched alone, on purpose
const INVISIBLE_RE = /[\u00AD\u180E\u200E\u200F\u2060-\u2064\uFE00-\uFE0F]/g;
// The same plus the zero-width characters normalizeUnicode drops, for the alternate reading.
// biome-ignore lint/suspicious/noMisleadingCharacterClass: variation selectors are matched alone, on purpose
const ALL_INVISIBLE_RE = /[\u00AD\u180E\u200B-\u200F\u2060-\u2064\uFEFF\uFE00-\uFE0F]/g;

// URLs and emails, which separator splitting would turn into prose.
const LINK_RE = /((?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s"'<>]+|[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)/;

export interface DetectionOptions {
	/** The other reading of ambiguous text, for Tier 1: invisible characters as spaces, leet reversed in ID-like tokens too. */
	alternate?: boolean;
	/** Leave URLs and emails out of separator splitting. */
	keepLinks?: boolean;
	/** Decode a leet token only when this returns true. */
	leetGate?: LeetGate;
}

/**
 * The analysis copy both tiers scan: control characters, combining marks, unicode
 * variants, look-alikes, joined words, spaced letters and leet undone. Never returned
 * to callers.
 */
export function normalizeForDetection(
	text: string,
	{ alternate = false, keepLinks = false, leetGate }: DetectionOptions = {},
): string {
	if (!text) return text;
	text = text.replace(CONTROL_RE, " ");
	text = alternate ? text.replace(ALL_INVISIBLE_RE, " ") : text.replace(INVISIBLE_RE, "");
	text = foldConfusables(normalizeUnicode(stripCombiningMarks(text.normalize("NFD"))));
	text = keepLinks
		? text
				.split(LINK_RE)
				.map((part, i) => (i % 2 ? part : normalizeWordSeparators(part)))
				.join("")
		: normalizeWordSeparators(text);
	return normalizeLeetSpeak(collapseSpacedLetters(text), !alternate, leetGate);
}
