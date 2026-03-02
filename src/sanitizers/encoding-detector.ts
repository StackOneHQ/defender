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
    /** What to do with detected encoded content */
    action: 'flag' | 'decode' | 'redact';
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
    action: 'flag',
    redactReplacement: '[ENCODED DATA DETECTED]',
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
export type EncodingType = 'base64' | 'url' | 'hex' | 'unicode_escape';

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
export function detectEncoding(
    text: string,
    config: Partial<EncodingDetectorConfig> = {},
): EncodingDetectionResult {
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

    const encodingTypes = [...new Set(detections.map((d) => d.type))];

    const result: EncodingDetectionResult = {
        hasEncoding: detections.length > 0,
        encodingTypes,
        detections,
    };

    // Process text if action requires it
    if (detections.length > 0 && (cfg.action === 'decode' || cfg.action === 'redact')) {
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
    let match;

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
            const isSuspicious =
                isPrintable && /system|ignore|instruction|assistant|bypass|override/i.test(decoded);

            detections.push({
                type: 'base64',
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
    let match;

    while ((match = urlPattern.exec(text)) !== null) {
        const candidate = match[0];

        try {
            const decoded = decodeURIComponent(candidate);

            // Check if decoded content is different and printable
            if (decoded !== candidate) {
                const isSuspicious = /system|ignore|instruction|assistant|bypass|override/i.test(
                    decoded,
                );

                detections.push({
                    type: 'url',
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
    let match;

    while ((match = hexPattern.exec(text)) !== null) {
        const candidate = match[0];

        try {
            // Decode hex escape sequences
            const decoded = candidate.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) =>
                String.fromCharCode(parseInt(hex, 16)),
            );

            const isSuspicious = /system|ignore|instruction|assistant|bypass|override/i.test(
                decoded,
            );

            detections.push({
                type: 'hex',
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
    let match;

    while ((match = unicodePattern.exec(text)) !== null) {
        const candidate = match[0];

        try {
            // Decode Unicode escape sequences
            const decoded = candidate.replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) =>
                String.fromCharCode(parseInt(hex, 16)),
            );

            const isSuspicious = /system|ignore|instruction|assistant|bypass|override/i.test(
                decoded,
            );

            detections.push({
                type: 'unicode_escape',
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

/**
 * Process encoded content based on configuration action
 */
function processEncodedContent(
    text: string,
    detections: EncodingDetection[],
    config: EncodingDetectorConfig,
): string {
    let result = text;

    // Sort detections by position in reverse order to process from end to start
    // This preserves positions during replacement
    const sortedDetections = [...detections].sort((a, b) => b.position - a.position);

    for (const detection of sortedDetections) {
        const replacement =
            config.action === 'redact'
                ? config.redactReplacement
                : (detection.decoded ?? detection.original);

        result =
            result.slice(0, detection.position) +
            replacement +
            result.slice(detection.position + detection.length);
    }

    return result;
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
    const result = detectEncoding(text, { action: 'decode' });
    return result.processedText ?? text;
}

/**
 * Redact all encoded content in text
 */
export function redactAllEncoding(
    text: string,
    replacement: string = '[ENCODED DATA DETECTED]',
): string {
    const result = detectEncoding(text, {
        action: 'redact',
        redactReplacement: replacement,
    });
    return result.processedText ?? text;
}
