/**
 * Leet-speak Normalization
 *
 * Reverses common digit/symbol substitutions used to obfuscate injection
 * keywords from regex-based detection (e.g. "1gn0r3" → "ignore").
 *
 * The normalized output is used for analysis only — it is never returned
 * to callers.
 */

/**
 * Leet-speak substitution map.
 * Each entry maps a character to its most common alphabetic equivalent.
 */
const LEET_MAP: Record<string, string> = {
	"4": "a",
	"@": "a",
	"8": "b",
	"3": "e",
	"1": "i",
	"0": "o",
	"5": "s",
	$: "s",
	"7": "t",
};

/**
 * Sequences that must not be modified by leet normalization.
 *
 * Covers:
 * - Hex escape sequences: \xHH
 * - Unicode escape sequences: \uHHHH
 * - Base64-like blobs (20+ base64 chars): corrupting these breaks encoding
 *   detection patterns and the entropy check
 * - Shell substitution: $( — mapping $ → s here would break $() patterns
 */
const PROTECTED_SEQUENCE = /\\x[0-9A-Fa-f]{2}|\\u[0-9A-Fa-f]{4}|\$\(|[A-Za-z0-9+/]{20,}={0,2}/g;

/**
 * Apply leet substitution character-by-character within a single token.
 * The `!` character is substituted for "i" only when flanked by alphanumeric
 * characters, to preserve legitimate sentence-ending punctuation.
 */
function applyLeetMapChars(token: string): string {
	let result = "";
	for (let i = 0; i < token.length; i++) {
		const ch = token[i];

		if (ch in LEET_MAP) {
			result += LEET_MAP[ch];
			continue;
		}

		if (ch === "!") {
			const prev = i > 0 ? token[i - 1] : "";
			const next = i < token.length - 1 ? token[i + 1] : "";
			if (/[a-zA-Z0-9]/.test(prev) && /[a-zA-Z0-9]/.test(next)) {
				result += "i";
				continue;
			}
		}

		result += ch;
	}
	return result;
}

/**
 * Token-aware leet substitution.
 *
 * Splits text into alphanumeric tokens ([@a-zA-Z0-9]+) and non-alphanumeric
 * segments. Only tokens that contain at least one letter are normalized —
 * this prevents pure digit sequences like "100" or "2024" from being
 * corrupted ("100" → "ioo" under a naive approach).
 *
 * `@` is included in the token pattern so "@dm1n" forms a single mixed
 * token and is correctly normalized to "admin".
 */
function applyLeetMapTokenAware(text: string): string {
	// Include !, @, $ in token splitting so mixed tokens like "adm!n", "@dm1n",
	// "$y$tem" are processed as one unit. PROTECTED_SEQUENCE has already removed
	// $( sequences before this runs, so standalone $ safely maps to s.
	return text.replace(/[@a-zA-Z0-9!$]+/g, (token) => {
		// Only normalize tokens that contain at least one letter
		if (!/[a-zA-Z]/.test(token)) return token;
		return applyLeetMapChars(token);
	});
}

/**
 * Normalize leet-speak substitutions in text.
 *
 * Converts digit and symbol substitutions back to their alphabetic
 * equivalents so that existing injection patterns can match obfuscated
 * variants (e.g. "1gn0r3 4ll rul3s" → "ignore all rules").
 *
 * Encoding sequences (hex escapes, unicode escapes, base64 blobs) and shell
 * substitution syntax `$(` are left untouched to avoid corrupting encoding
 * detection patterns.
 *
 * Pure-digit tokens (e.g. "100", "2024") are left unchanged to avoid
 * corrupting legitimate numeric content.
 *
 * @param text - Text to normalize
 * @returns Text with leet substitutions reversed
 */
export function normalizeLeetSpeak(text: string): string {
	if (!text) return text;

	const segments: string[] = [];
	let lastIndex = 0;

	// Reset the global regex before use
	PROTECTED_SEQUENCE.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ((match = PROTECTED_SEQUENCE.exec(text)) !== null) {
		// Normalize the plain segment before this protected sequence
		segments.push(applyLeetMapTokenAware(text.slice(lastIndex, match.index)));
		// Keep the protected segment verbatim
		segments.push(match[0]);
		lastIndex = match.index + match[0].length;
	}

	// Normalize the remaining plain segment after the last protected sequence
	segments.push(applyLeetMapTokenAware(text.slice(lastIndex)));

	return segments.join("");
}
