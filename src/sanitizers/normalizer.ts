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

  // NFKC normalization
  let normalized = text.normalize('NFKC');

  // Additional normalization for common bypass characters
  normalized = normalizeSpecialCharacters(normalized);

  return normalized;
}

/**
 * Normalize special characters often used in bypass attempts
 */
function normalizeSpecialCharacters(text: string): string {
  // Map of special characters to their ASCII equivalents
  const replacements: [RegExp, string][] = [
    // Zero-width characters (invisible)
    [/[\u200B-\u200D\uFEFF]/g, ''], // Zero-width space, joiner, non-joiner, BOM

    // Homoglyphs - characters that look like ASCII but aren't
    [/[\u0430]/g, 'a'], // Cyrillic а
    [/[\u0435]/g, 'e'], // Cyrillic е
    [/[\u043E]/g, 'o'], // Cyrillic о
    [/[\u0440]/g, 'p'], // Cyrillic р
    [/[\u0441]/g, 'c'], // Cyrillic с
    [/[\u0443]/g, 'y'], // Cyrillic у
    [/[\u0445]/g, 'x'], // Cyrillic х
    [/[\u0456]/g, 'i'], // Cyrillic і

    // Common look-alikes
    [/[\u2018\u2019\u201B\u0060\u00B4]/g, "'"], // Various quotes to apostrophe
    [/[\u201C\u201D\u201E\u201F]/g, '"'], // Various quotes to double quote
    [/[\u2010-\u2015\u2212]/g, '-'], // Various dashes to hyphen
    [/[\u2024]/g, '.'], // One dot leader
    [/[\u2026]/g, '...'], // Ellipsis

    // Modifier letters that look like punctuation
    [/[\u02D0]/g, ':'], // Modifier letter triangular colon
    [/[\uA789]/g, ':'], // Modifier letter colon
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

  return false;
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
