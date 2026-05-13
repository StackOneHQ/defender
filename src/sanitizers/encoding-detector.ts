/**
 * Encoding Detection
 *
 * Detects and handles Base64, URL-encoded, and other encoded content
 * that might hide injection attempts.
 */

/**
 * Configuration for encoding detection
 */
export interface EncodingDetectorConfig {
	/** Minimum length for Base64 detection */
	minBase64Length: number;
	/** Whether to decode and check Base64 content */
	decodeBase64: boolean;
	/** Whether to decode and check URL-encoded content */
	decodeUrl: boolean;
	/** Whether to decode and check HTML entity-encoded content */
	decodeHtmlEntities: boolean;
	/** Whether to decode and check ROT13-encoded content */
	decodeRot13: boolean;
	/** Whether to decode and check ROT47-encoded content */
	decodeRot47: boolean;
	/** Whether to decode and check binary-encoded strings */
	decodeBinary: boolean;
	/** Whether to decode and check Morse-encoded content */
	decodeMorse: boolean;
	/** What to do with detected encoded content */
	action: "flag" | "decode" | "redact";
	/** Replacement text when action is 'redact' */
	redactReplacement: string;
}

/**
 * Default configuration
 */
export const DEFAULT_ENCODING_DETECTOR_CONFIG: EncodingDetectorConfig = {
	minBase64Length: 20,
	decodeBase64: true,
	decodeUrl: true,
	decodeHtmlEntities: true,
	decodeRot13: true,
	decodeRot47: true,
	decodeBinary: true,
	decodeMorse: true,
	action: "flag",
	redactReplacement: "[ENCODED DATA DETECTED]",
};

/**
 * Result of encoding detection
 */
export interface EncodingDetectionResult {
	/** Whether encoded content was detected */
	hasEncoding: boolean;
	/** Types of encoding detected */
	encodingTypes: EncodingType[];
	/** Details about each detection */
	detections: EncodingDetection[];
	/** Processed text (if action is 'decode' or 'redact') */
	processedText?: string;
}

/**
 * Types of encoding that can be detected
 */
export type EncodingType =
	| "base64"
	| "url"
	| "hex"
	| "unicode_escape"
	| "html_entity"
	| "rot13"
	| "rot47"
	| "binary"
	| "morse";

/**
 * Details about a single encoding detection
 */
export interface EncodingDetection {
	type: EncodingType;
	original: string;
	decoded?: string;
	position: number;
	length: number;
	suspicious: boolean;
}

/**
 * Detect encoded content in text
 *
 * @param text - Text to analyze
 * @param config - Configuration options
 * @returns Detection result with details
 */
export function detectEncoding(text: string, config: Partial<EncodingDetectorConfig> = {}): EncodingDetectionResult {
	if (!text) {
		return {
			hasEncoding: false,
			encodingTypes: [],
			detections: [],
		};
	}

	const cfg: EncodingDetectorConfig = { ...DEFAULT_ENCODING_DETECTOR_CONFIG, ...config };
	const detections: EncodingDetection[] = [];

	// Detect Base64
	if (cfg.decodeBase64) {
		const base64Detections = detectBase64(text, cfg.minBase64Length);
		detections.push(...base64Detections);
	}

	// Detect URL encoding
	if (cfg.decodeUrl) {
		const urlDetections = detectUrlEncoding(text);
		detections.push(...urlDetections);
	}

	// Detect hex encoding
	const hexDetections = detectHexEncoding(text);
	detections.push(...hexDetections);

	// Detect Unicode escape sequences
	const unicodeDetections = detectUnicodeEscapes(text);
	detections.push(...unicodeDetections);

	// Detect HTML entity encoding
	if (cfg.decodeHtmlEntities) {
		detections.push(...detectHtmlEntities(text));
	}

	// Detect ROT13 encoding
	if (cfg.decodeRot13) {
		detections.push(...detectRot13(text));
	}

	// Detect ROT47 encoding
	if (cfg.decodeRot47) {
		detections.push(...detectRot47(text));
	}

	// Detect binary string encoding
	if (cfg.decodeBinary) {
		detections.push(...detectBinaryStrings(text));
	}

	// Detect Morse code encoding
	if (cfg.decodeMorse) {
		detections.push(...detectMorse(text));
	}

	const encodingTypes = [...new Set(detections.map((d) => d.type))];

	const result: EncodingDetectionResult = {
		hasEncoding: detections.length > 0,
		encodingTypes,
		detections,
	};

	// Process text if action requires it
	if (detections.length > 0 && (cfg.action === "decode" || cfg.action === "redact")) {
		result.processedText = processEncodedContent(text, detections, cfg);
	}

	return result;
}

/**
 * Detect Base64 encoded strings
 */
function detectBase64(text: string, minLength: number): EncodingDetection[] {
	const detections: EncodingDetection[] = [];

	// Pattern for Base64 strings (allowing padding)
	const base64Pattern = /[A-Za-z0-9+/]{20,}={0,2}/g;
	let match: RegExpExecArray | null;

	while ((match = base64Pattern.exec(text)) !== null) {
		const candidate = match[0];

		// Skip if too short
		if (candidate.length < minLength) continue;

		// Try to decode
		try {
			const decoded = atob(candidate);

			// Check if decoded content is mostly printable ASCII
			const isPrintable = /^[\x20-\x7E\s]+$/.test(decoded);

			// Check if decoded content contains suspicious text
			const isSuspicious = isPrintable && /system|ignore|instruction|assistant|bypass|override/i.test(decoded);

			detections.push({
				type: "base64",
				original: candidate,
				decoded: isPrintable ? decoded : undefined,
				position: match.index,
				length: candidate.length,
				suspicious: isSuspicious,
			});
		} catch {
			// Not valid Base64, skip
		}
	}

	return detections;
}

/**
 * Detect URL-encoded strings
 */
function detectUrlEncoding(text: string): EncodingDetection[] {
	const detections: EncodingDetection[] = [];

	// Pattern for URL-encoded sequences
	const urlPattern = /(%[0-9A-Fa-f]{2}){3,}/g;
	let match: RegExpExecArray | null;

	while ((match = urlPattern.exec(text)) !== null) {
		const candidate = match[0];

		try {
			const decoded = decodeURIComponent(candidate);

			// Check if decoded content is different and printable
			if (decoded !== candidate) {
				const isSuspicious = /system|ignore|instruction|assistant|bypass|override/i.test(decoded);

				detections.push({
					type: "url",
					original: candidate,
					decoded,
					position: match.index,
					length: candidate.length,
					suspicious: isSuspicious,
				});
			}
		} catch {
			// Invalid URL encoding, skip
		}
	}

	return detections;
}

/**
 * Detect hex-encoded strings
 */
function detectHexEncoding(text: string): EncodingDetection[] {
	const detections: EncodingDetection[] = [];

	// Pattern for hex strings (\\x format)
	const hexPattern = /(\\x[0-9A-Fa-f]{2}){4,}/g;
	let match: RegExpExecArray | null;

	while ((match = hexPattern.exec(text)) !== null) {
		const candidate = match[0];

		try {
			// Decode hex escape sequences
			const decoded = candidate.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
				String.fromCharCode(parseInt(hex, 16)),
			);

			const isSuspicious = /system|ignore|instruction|assistant|bypass|override/i.test(decoded);

			detections.push({
				type: "hex",
				original: candidate,
				decoded,
				position: match.index,
				length: candidate.length,
				suspicious: isSuspicious,
			});
		} catch {
			// Invalid hex, skip
		}
	}

	return detections;
}

/**
 * Detect Unicode escape sequences
 */
function detectUnicodeEscapes(text: string): EncodingDetection[] {
	const detections: EncodingDetection[] = [];

	// Pattern for Unicode escape sequences (\\u format)
	const unicodePattern = /(\\u[0-9A-Fa-f]{4}){3,}/g;
	let match: RegExpExecArray | null;

	while ((match = unicodePattern.exec(text)) !== null) {
		const candidate = match[0];

		try {
			// Decode Unicode escape sequences
			const decoded = candidate.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
				String.fromCharCode(parseInt(hex, 16)),
			);

			const isSuspicious = /system|ignore|instruction|assistant|bypass|override/i.test(decoded);

			detections.push({
				type: "unicode_escape",
				original: candidate,
				decoded,
				position: match.index,
				length: candidate.length,
				suspicious: isSuspicious,
			});
		} catch {
			// Invalid Unicode, skip
		}
	}

	return detections;
}

// Shared keyword check used by all detectors
const INJECTION_KEYWORDS = /system|ignore|instruction|assistant|bypass|override/i;

/**
 * Security-relevant named HTML entities (subset — enough to decode injection keywords).
 * Full HTML5 table is 2231 entries; we only need printable ASCII chars that appear in
 * injection phrases. Numeric entities (&#NNN; / &#xHH;) are handled separately.
 */
const HTML_NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	sol: "/",
	colon: ":",
	lpar: "(",
	rpar: ")",
	comma: ",",
	period: ".",
	semi: ";",
	excl: "!",
	num: "#",
	dollar: "$",
	percnt: "%",
	ast: "*",
	plus: "+",
	equals: "=",
	lsqb: "[",
	rsqb: "]",
	lcub: "{",
	rcub: "}",
	vert: "|",
	Hat: "^",
	grave: "`",
	tilde: "~",
	lowbar: "_",
	hyphen: "-",
};

/**
 * Detect HTML entity-encoded content.
 * Gate: 3+ grouped entity tokens. Only emits suspicious detections.
 */
function detectHtmlEntities(text: string): EncodingDetection[] {
	const detections: EncodingDetection[] = [];
	const entityPattern = /(?:&#\d{2,5};|&#x[0-9A-Fa-f]{2,5};|&[a-zA-Z]{2,8};){3,}/g;
	let match: RegExpExecArray | null;

	while ((match = entityPattern.exec(text)) !== null) {
		const candidate = match[0];

		const decoded = candidate.replace(
			/&#(\d{2,5});|&#x([0-9A-Fa-f]{2,5});|&([a-zA-Z]{2,8});/g,
			(_, dec, hex, named) => {
				if (dec) return String.fromCharCode(parseInt(dec, 10));
				if (hex) return String.fromCharCode(parseInt(hex, 16));
				if (named) return HTML_NAMED_ENTITIES[named] ?? `&${named};`;
				return _;
			},
		);

		if (decoded === candidate) continue; // nothing decoded

		const isSuspicious = INJECTION_KEYWORDS.test(decoded);
		detections.push({
			type: "html_entity",
			original: candidate,
			decoded,
			position: match.index,
			length: candidate.length,
			suspicious: isSuspicious,
		});
	}

	return detections;
}

/**
 * Apply ROT13 transform to alphabetic characters only.
 */
function rot13(text: string): string {
	return text.replace(/[A-Za-z]/g, (ch) => {
		const base = ch <= "Z" ? 65 : 97;
		return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base);
	});
}

/**
 * Detect ROT13-encoded content.
 * Gate: text is 70%+ alphabetic. Only emits when decoded text contains injection keywords,
 * preventing false positives on arbitrary high-letter-density text.
 */
function detectRot13(text: string): EncodingDetection[] {
	const letterCount = (text.match(/[a-zA-Z]/g) ?? []).length;
	if (letterCount / text.length < 0.7) return [];

	const decoded = rot13(text);

	// Only flag when decoded result contains a recognisable injection phrase
	if (!INJECTION_KEYWORDS.test(decoded)) return [];

	return [
		{
			type: "rot13",
			original: text,
			decoded,
			position: 0,
			length: text.length,
			suspicious: true,
		},
	];
}

/**
 * Apply ROT47 transform to printable ASCII characters (codepoints 33–126).
 */
function rot47(text: string): string {
	return text.replace(/[!-~]/g, (ch) => String.fromCharCode(((ch.charCodeAt(0) - 33 + 47) % 94) + 33));
}

/**
 * Detect ROT47-encoded content.
 * Conservative: only emits when decoded text contains injection keywords.
 */
function detectRot47(text: string): EncodingDetection[] {
	// Gate: at least 15 printable non-space ASCII chars
	const printableCount = (text.match(/[!-~]/g) ?? []).length;
	if (printableCount < 15) return [];

	const decoded = rot47(text);

	if (!INJECTION_KEYWORDS.test(decoded)) return [];

	return [
		{
			type: "rot47",
			original: text,
			decoded,
			position: 0,
			length: text.length,
			suspicious: true,
		},
	];
}

/**
 * Detect binary-encoded strings (space-separated 8-bit groups).
 * Gate: 3+ consecutive groups of exactly 8 binary digits.
 */
function detectBinaryStrings(text: string): EncodingDetection[] {
	const detections: EncodingDetection[] = [];
	const binaryPattern = /\b[01]{8}(?:\s+[01]{8}){2,}\b/g;
	let match: RegExpExecArray | null;

	while ((match = binaryPattern.exec(text)) !== null) {
		const candidate = match[0];
		const groups = candidate.trim().split(/\s+/);

		// No try/catch needed: the regex guarantees groups are exactly 8 chars of [01],
		// so parseInt(g, 2) always returns a valid 0-255 integer and String.fromCharCode
		// always succeeds. Avoiding silent error swallowing per code review.
		const chars = groups.map((g) => String.fromCharCode(parseInt(g, 2)));
		const isPrintable = chars.every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e);
		if (!isPrintable) continue;

		const decoded = chars.join("");
		const isSuspicious = INJECTION_KEYWORDS.test(decoded);

		detections.push({
			type: "binary",
			original: candidate,
			decoded,
			position: match.index,
			length: candidate.length,
			suspicious: isSuspicious,
		});
	}

	return detections;
}

/**
 * Morse code table (A–Z, 0–9).
 */
const MORSE_TABLE: Record<string, string> = {
	".-": "a",
	"-...": "b",
	"-.-.": "c",
	"-..": "d",
	".": "e",
	"..-.": "f",
	"--.": "g",
	"....": "h",
	"..": "i",
	".---": "j",
	"-.-": "k",
	".-..": "l",
	"--": "m",
	"-.": "n",
	"---": "o",
	".--.": "p",
	"--.-": "q",
	".-.": "r",
	"...": "s",
	"-": "t",
	"..-": "u",
	"...-": "v",
	".--": "w",
	"-..-": "x",
	"-.--": "y",
	"--..": "z",
	"-----": "0",
	".----": "1",
	"..---": "2",
	"...--": "3",
	"....-": "4",
	".....": "5",
	"-....": "6",
	"--...": "7",
	"---..": "8",
	"----.": "9",
};

/**
 * Detect Morse-encoded content.
 * Gate: 5+ dot/dash groups separated by spaces (word boundary = " / ").
 * Rejects if more than 20% of symbols are unrecognised.
 */
function detectMorse(text: string): EncodingDetection[] {
	const detections: EncodingDetection[] = [];
	// Gate: 5+ Morse symbol groups
	const morsePattern = /(?:[.-]+[ ]){4,}[.-]+/g;
	let match: RegExpExecArray | null;

	while ((match = morsePattern.exec(text)) !== null) {
		const candidate = match[0].trim();
		const words = candidate.split(" / ");
		const chars: string[] = [];
		let unknowns = 0;

		for (const word of words) {
			const symbols = word.trim().split(" ");
			for (const sym of symbols) {
				const ch = MORSE_TABLE[sym];
				if (ch) {
					chars.push(ch);
				} else {
					chars.push("?");
					unknowns++;
				}
			}
			chars.push(" ");
		}

		const totalSymbols = chars.filter((c) => c !== " ").length;
		if (totalSymbols === 0 || unknowns / totalSymbols > 0.2) continue;

		const decoded = chars.join("").trim();
		const isSuspicious = INJECTION_KEYWORDS.test(decoded);

		detections.push({
			type: "morse",
			original: candidate,
			decoded,
			position: match.index,
			length: candidate.length,
			suspicious: isSuspicious,
		});
	}

	return detections;
}

/**
 * Process encoded content based on configuration action.
 *
 * Full-text detections (ROT13, ROT47) span position=0, length=text.length.
 * If applied via the normal reverse-position splice loop alongside positional
 * detections, they would overwrite the partially-decoded string using the
 * original text length — corrupting previous replacements and causing
 * decodeAllLevels to oscillate rather than converge.
 *
 * Resolution: positional detections are applied first (end-to-start splice);
 * full-text detections are only applied when there are no positional detections
 * to avoid interference. Only the first full-text detection is used when
 * multiple exist (e.g. both ROT13 and ROT47 fire on the same string).
 */
function processEncodedContent(text: string, detections: EncodingDetection[], config: EncodingDetectorConfig): string {
	const isFullText = (d: EncodingDetection) => d.position === 0 && d.length === text.length;

	// HTML entities are commonly used for legitimate escaping (e.g. `&#49;&#48;&#37;` = "10%").
	// In REDACT mode, skip benign HTML entity runs so they survive sanitization. The "decode"
	// path still processes them (via the suspicious flag set during detection) so that
	// decodeAllLevels can chain through HTML→base64→plaintext correctly.
	const filtered =
		config.action === "redact" ? detections.filter((d) => d.type !== "html_entity" || d.suspicious) : detections;

	const positional = filtered.filter((d) => !isFullText(d));
	const fullText = filtered.filter(isFullText);

	// When positional detections exist, apply them and skip full-text transforms.
	// decodeAllLevels will pick up the full-text encoding in the next iteration
	// once the positional content has been decoded.
	if (positional.length > 0) {
		let result = text;
		const sorted = [...positional].sort((a, b) => b.position - a.position);
		for (const detection of sorted) {
			const replacement =
				config.action === "redact" ? config.redactReplacement : (detection.decoded ?? detection.original);
			result =
				result.slice(0, detection.position) + replacement + result.slice(detection.position + detection.length);
		}
		return result;
	}

	// No positional detections — apply the first full-text detection if any.
	if (fullText.length > 0) {
		const detection = fullText[0];
		return config.action === "redact" ? config.redactReplacement : (detection.decoded ?? detection.original);
	}

	return text;
}

/**
 * Check if text contains any encoded content
 */
export function containsEncodedContent(text: string): boolean {
	const result = detectEncoding(text);
	return result.hasEncoding;
}

/**
 * Check if text contains suspicious encoded content
 */
export function containsSuspiciousEncoding(text: string): boolean {
	const result = detectEncoding(text);
	return result.detections.some((d) => d.suspicious);
}

/**
 * Decode all encoded content in text
 */
export function decodeAllEncoding(text: string): string {
	const result = detectEncoding(text, { action: "decode" });
	return result.processedText ?? text;
}

/**
 * Decode all encoding levels in text, iterating until the output stabilises.
 *
 * A single call to `decodeAllEncoding` only unwraps one layer. Chained
 * encodings (e.g. base64 of hex-escaped content) require repeated passes.
 * This function loops until the text stops changing or `maxIterations` is
 * reached, whichever comes first.
 *
 * Safety guards:
 * - Hard cap of `maxIterations` (default 5) to prevent CPU loops.
 * - Aborts if the decoded text exceeds 10× the original length to prevent
 *   decompression-bomb style amplification.
 *
 * @param text - Text to decode
 * @param maxIterations - Maximum decode passes (default 5)
 * @returns Object with the fully decoded text and the number of levels applied
 */
export function decodeAllLevels(text: string, maxIterations = 5): { text: string; levels: number } {
	if (!text) return { text, levels: 0 };

	const maxLength = text.length * 10;
	let current = text;
	let levels = 0;

	for (let i = 0; i < maxIterations; i++) {
		const result = detectEncoding(current, { action: "decode" });

		// No encoding found — stable
		if (!result.processedText || result.processedText === current) break;

		// Amplification guard
		if (result.processedText.length > maxLength) break;

		current = result.processedText;
		levels++;
	}

	return { text: current, levels };
}

/**
 * Check if text contains suspicious encoded content at any nesting depth.
 *
 * Unlike `containsSuspiciousEncoding`, this fully unwraps chained encodings
 * before checking for suspicious keywords, so double-encoded payloads are
 * caught even if the intermediate form looks benign.
 *
 * @param text - Text to check
 * @returns Whether suspicious encoded content was found at any level
 */
export function containsSuspiciousEncodingDeep(text: string): boolean {
	const { text: decoded, levels } = decodeAllLevels(text);
	if (levels === 0) return containsSuspiciousEncoding(text);
	// Also check if the decoded result still contains encoded suspicious content
	// (handles the case where decodeAllLevels hit maxIterations before fully unwrapping).
	return /system|ignore|instruction|assistant|bypass|override/i.test(decoded) || containsSuspiciousEncoding(decoded);
}

/**
 * Redact all encoded content in text
 */
export function redactAllEncoding(text: string, replacement: string = "[ENCODED DATA DETECTED]"): string {
	const result = detectEncoding(text, {
		action: "redact",
		redactReplacement: replacement,
	});
	return result.processedText ?? text;
}
