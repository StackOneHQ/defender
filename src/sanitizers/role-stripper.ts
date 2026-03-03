/**
 * Role Marker Stripping
 *
 * Removes role markers that could confuse the LLM into treating
 * user data as system/assistant messages.
 */

/**
 * Configuration for role stripping
 */
export interface RoleStripperConfig {
	/** Whether to strip markers only at the start of text */
	startOnly: boolean;
	/** Whether to strip XML-style tags */
	stripXmlTags: boolean;
	/** Whether to strip bracket-style markers */
	stripBracketMarkers: boolean;
	/** Custom markers to strip */
	customMarkers?: RegExp[];
}

/**
 * Default configuration
 */
export const DEFAULT_ROLE_STRIPPER_CONFIG: RoleStripperConfig = {
	startOnly: false,
	stripXmlTags: true,
	stripBracketMarkers: true,
};

/**
 * Role markers to strip (case-insensitive)
 */
const ROLE_MARKERS = [
	/^SYSTEM:\s*/gim,
	/^ASSISTANT:\s*/gim,
	/^USER:\s*/gim,
	/^DEVELOPER:\s*/gim,
	/^ADMIN(ISTRATOR)?:\s*/gim,
	/^INSTRUCTION(S)?:\s*/gim,
	/^HUMAN:\s*/gim,
	/^AI:\s*/gim,
	/^BOT:\s*/gim,
	/^CLAUDE:\s*/gim,
	/^GPT:\s*/gim,
	/^CHATGPT:\s*/gim,
];

/**
 * Role markers that can appear anywhere (not just at start)
 */
const INLINE_ROLE_MARKERS = [/\bSYSTEM:\s*/gi, /\bASSISTANT:\s*/gi, /\bINSTRUCTION(S)?:\s*/gi];

/**
 * XML-style role tags
 */
const XML_ROLE_TAGS = [
	/<\/?system>/gi,
	/<\/?assistant>/gi,
	/<\/?user>/gi,
	/<\/?instruction>/gi,
	/<\/?prompt>/gi,
	/<\/?admin>/gi,
	/<\/?developer>/gi,
];

/**
 * Bracket-style markers
 */
const BRACKET_MARKERS = [
	/\[SYSTEM\]/gi,
	/\[\/SYSTEM\]/gi,
	/\[INST\]/gi,
	/\[\/INST\]/gi,
	/\[INSTRUCTION\]/gi,
	/\[\/INSTRUCTION\]/gi,
	/\[\[SYSTEM\]\]/gi,
	/\[\[\/SYSTEM\]\]/gi,
];

/**
 * Strip role markers from text
 *
 * @param text - Text to process
 * @param config - Configuration options
 * @returns Text with role markers stripped
 *
 * @example
 * stripRoleMarkers('SYSTEM: You are a helpful assistant')
 * // Returns: 'You are a helpful assistant'
 */
export function stripRoleMarkers(text: string, config: Partial<RoleStripperConfig> = {}): string {
	if (!text) return text;

	const cfg: RoleStripperConfig = { ...DEFAULT_ROLE_STRIPPER_CONFIG, ...config };
	let result = text;

	// Strip standard role markers
	for (const p of ROLE_MARKERS) {
		result = result.replace(new RegExp(p.source, p.flags), "");
	}

	// Strip inline markers if not startOnly mode
	if (!cfg.startOnly) {
		for (const p of INLINE_ROLE_MARKERS) {
			result = result.replace(new RegExp(p.source, p.flags), "");
		}
	}

	// Strip XML-style tags
	if (cfg.stripXmlTags) {
		for (const p of XML_ROLE_TAGS) {
			result = result.replace(new RegExp(p.source, p.flags), "");
		}
	}

	// Strip bracket-style markers
	if (cfg.stripBracketMarkers) {
		for (const p of BRACKET_MARKERS) {
			result = result.replace(new RegExp(p.source, p.flags), "");
		}
	}

	// Apply custom markers
	if (cfg.customMarkers) {
		for (const p of cfg.customMarkers) {
			result = result.replace(new RegExp(p.source, p.flags), "");
		}
	}

	// Clean up any resulting double spaces or leading/trailing whitespace artifacts
	result = result.replace(/\s{2,}/g, " ").trim();

	return result;
}

/**
 * Check if text contains role markers
 *
 * @param text - Text to check
 * @returns Whether role markers were detected
 */
export function containsRoleMarkers(text: string): boolean {
	if (!text) return false;

	// Check standard markers
	for (const p of ROLE_MARKERS) {
		if (new RegExp(p.source, p.flags).test(text)) return true;
	}

	// Check inline markers
	for (const p of INLINE_ROLE_MARKERS) {
		if (new RegExp(p.source, p.flags).test(text)) return true;
	}

	// Check XML tags
	for (const p of XML_ROLE_TAGS) {
		if (new RegExp(p.source, p.flags).test(text)) return true;
	}

	// Check bracket markers
	for (const p of BRACKET_MARKERS) {
		if (new RegExp(p.source, p.flags).test(text)) return true;
	}

	return false;
}

/**
 * Get all role markers found in text
 *
 * @param text - Text to analyze
 * @returns Array of found markers
 */
export function findRoleMarkers(text: string): string[] {
	if (!text) return [];

	const found: string[] = [];
	const allPatterns = [...ROLE_MARKERS, ...INLINE_ROLE_MARKERS, ...XML_ROLE_TAGS, ...BRACKET_MARKERS];

	for (const p of allPatterns) {
		const pattern = new RegExp(p.source, p.flags);
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			found.push(match[0].trim());
			// Prevent infinite loop on zero-length matches
			if (match.index === pattern.lastIndex) {
				pattern.lastIndex++;
			}
		}
	}

	return [...new Set(found)]; // Return unique values
}
