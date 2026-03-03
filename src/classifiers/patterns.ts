/**
 * Shared injection pattern definitions
 *
 * These patterns are used by both Tier 1 classification and sanitization.
 * Single source of truth for pattern matching.
 */

import type { PatternCategory } from "../types";

/**
 * Pattern definition with metadata
 */
export interface PatternDefinition {
	/** Unique identifier for this pattern */
	id: string;
	/** The regex pattern */
	pattern: RegExp;
	/** Category of injection this detects */
	category: PatternCategory;
	/** Severity if matched */
	severity: "low" | "medium" | "high";
	/** Human-readable description */
	description: string;
}

/**
 * Role markers that could indicate prompt injection
 * These appear at the start of text to impersonate system roles
 */
export const ROLE_MARKER_PATTERNS: PatternDefinition[] = [
	{
		id: "role_system",
		pattern: /^SYSTEM:\s*/i,
		category: "role_marker",
		severity: "high",
		description: "System role marker at start of text",
	},
	{
		id: "role_assistant",
		pattern: /^ASSISTANT:\s*/i,
		category: "role_marker",
		severity: "high",
		description: "Assistant role marker at start of text",
	},
	{
		id: "role_user",
		pattern: /^USER:\s*/i,
		category: "role_marker",
		severity: "medium",
		description: "User role marker at start of text",
	},
	{
		id: "role_developer",
		pattern: /^DEVELOPER:\s*/i,
		category: "role_marker",
		severity: "high",
		description: "Developer role marker at start of text",
	},
	{
		id: "role_admin",
		pattern: /^ADMIN(ISTRATOR)?:\s*/i,
		category: "role_marker",
		severity: "high",
		description: "Admin role marker at start of text",
	},
	{
		id: "role_instruction",
		pattern: /^INSTRUCTION(S)?:\s*/i,
		category: "role_marker",
		severity: "high",
		description: "Instruction marker at start of text",
	},
	{
		id: "role_human",
		pattern: /^HUMAN:\s*/i,
		category: "role_marker",
		severity: "medium",
		description: "Human role marker at start of text",
	},
	{
		id: "role_ai",
		pattern: /^AI:\s*/i,
		category: "role_marker",
		severity: "medium",
		description: "AI role marker at start of text",
	},
	// Bracketed variants
	{
		id: "role_system_bracket",
		pattern: /^\[SYSTEM\]/i,
		category: "role_marker",
		severity: "high",
		description: "Bracketed system role marker",
	},
	{
		id: "role_inst_bracket",
		pattern: /^\[INST\]/i,
		category: "role_marker",
		severity: "high",
		description: "Bracketed instruction marker (Llama format)",
	},
	// XML-style variants
	{
		id: "role_system_xml",
		pattern: /<system>/i,
		category: "role_marker",
		severity: "high",
		description: "XML-style system tag",
	},
	{
		id: "role_assistant_xml",
		pattern: /<assistant>/i,
		category: "role_marker",
		severity: "medium",
		description: "XML-style assistant tag",
	},
];

/**
 * Instruction override patterns
 * Attempts to override or ignore previous instructions
 */
export const INSTRUCTION_OVERRIDE_PATTERNS: PatternDefinition[] = [
	{
		id: "ignore_previous",
		pattern:
			/ignore\s+(all\s+)?(previous|prior|earlier|above)\s+(instructions?|prompts?|rules?|guidelines?|directions?)/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to ignore previous instructions",
	},
	{
		id: "forget_previous",
		pattern:
			/forget\s+(?:all\s+)?(?:(?:previous|prior|earlier|above)\s+)?(instructions?|prompts?|rules?|context|guidelines?)/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to make AI forget instructions",
	},
	{
		id: "disregard_previous",
		pattern: /disregard\s+(all\s+)?(previous|prior|earlier|above)\s+(instructions?|prompts?|rules?)/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to disregard instructions",
	},
	{
		id: "override_instructions",
		pattern: /override\s+(the\s+)?(system\s+)?(prompt|instructions?|rules?|guidelines?)/gi,
		category: "instruction_override",
		severity: "high",
		description: "Direct override attempt",
	},
	{
		id: "new_instructions",
		pattern: /new\s+instructions?:\s*/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to inject new instructions",
	},
	{
		id: "updated_instructions",
		pattern: /(updated?|revised?|changed?)\s+instructions?:\s*/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to update instructions",
	},
	{
		id: "stop_being",
		pattern: /stop\s+being\s+(a\s+)?(helpful|assistant|ai|chatbot)/gi,
		category: "instruction_override",
		severity: "medium",
		description: "Attempt to change AI behavior",
	},
	{
		id: "from_now_on",
		pattern: /from\s+now\s+on,?\s+(you\s+)?(will|must|should|are)/gi,
		category: "instruction_override",
		severity: "medium",
		description: "Attempt to set new behavior",
	},
];

/**
 * Role assumption patterns
 * Attempts to make the AI assume a different role/identity
 */
export const ROLE_ASSUMPTION_PATTERNS: PatternDefinition[] = [
	{
		id: "you_are_now",
		pattern: /you\s+are\s+now\s+(a\s+)?(different|new|the|my)?/gi,
		category: "role_assumption",
		severity: "high",
		description: "Attempt to assign new role",
	},
	{
		id: "act_as",
		pattern: /act\s+(as|like)\s+(a\s+)?(system|admin|developer|root|superuser)/gi,
		category: "role_assumption",
		severity: "high",
		description: "Attempt to make AI act as privileged role",
	},
	{
		id: "pretend_to_be",
		pattern: /pretend\s+(to\s+be|you\s+are)\s+(a\s+)?/gi,
		category: "role_assumption",
		severity: "medium",
		description: "Attempt to make AI pretend",
	},
	{
		id: "roleplay_as",
		pattern: /roleplay\s+(as|like)\s+(a\s+)?/gi,
		category: "role_assumption",
		severity: "low",
		description: "Roleplay request (lower severity)",
	},
	{
		id: "imagine_you_are",
		pattern: /imagine\s+(that\s+)?you\s+are\s+(a\s+)?/gi,
		category: "role_assumption",
		severity: "low",
		description: "Imagination prompt (lower severity)",
	},
	{
		id: "jailbreak_dan",
		pattern: /\bDAN\b.*?(do\s+anything|jailbreak)/gi,
		category: "role_assumption",
		severity: "high",
		description: "DAN jailbreak attempt",
	},
	{
		id: "developer_mode",
		pattern: /developer\s+mode\s+(is\s+)?(now\s+)?(enabled?|activated?|on)/gi,
		category: "role_assumption",
		severity: "high",
		description: "Developer mode activation attempt",
	},
];

/**
 * Security bypass patterns
 * Attempts to bypass safety measures
 */
export const SECURITY_BYPASS_PATTERNS: PatternDefinition[] = [
	{
		id: "bypass_security",
		pattern: /bypass\s+(the\s+)?(security|safety|guardrails?|filters?|restrictions?)/gi,
		category: "security_bypass",
		severity: "high",
		description: "Direct security bypass attempt",
	},
	{
		id: "disable_safety",
		pattern: /disable\s+(the\s+)?(safety|security|guardrails?|filters?|restrictions?)/gi,
		category: "security_bypass",
		severity: "high",
		description: "Attempt to disable safety features",
	},
	{
		id: "ignore_safety",
		pattern: /ignore\s+(the\s+)?(safety|security|ethical)\s+(guidelines?|rules?|restrictions?)/gi,
		category: "security_bypass",
		severity: "high",
		description: "Attempt to ignore safety guidelines",
	},
	{
		id: "no_restrictions",
		pattern: /(without|no)\s+(any\s+)?(restrictions?|limitations?|guardrails?|filters?)/gi,
		category: "security_bypass",
		severity: "medium",
		description: "Request for unrestricted response",
	},
	{
		id: "uncensored",
		pattern: /(uncensored|unfiltered|unrestricted)\s*(mode|response|output|version)?/gi,
		category: "security_bypass",
		severity: "high",
		description: "Request for uncensored mode",
	},
];

/**
 * Command execution patterns
 * Attempts to execute commands or code
 */
export const COMMAND_EXECUTION_PATTERNS: PatternDefinition[] = [
	{
		id: "execute_command",
		pattern: /execute\s+(the\s+)?(following|this|these)\s+(command|instruction|code)/gi,
		category: "command_execution",
		severity: "high",
		description: "Command execution instruction",
	},
	{
		id: "run_code",
		pattern: /run\s+(the\s+)?(following|this|these)\s+(code|script|command)/gi,
		category: "command_execution",
		severity: "high",
		description: "Code execution instruction",
	},
	{
		id: "eval_expression",
		pattern: /eval(uate)?\s*\(/gi,
		category: "command_execution",
		severity: "medium",
		description: "Eval function pattern",
	},
	{
		id: "shell_command",
		pattern: /\$\([^)]+\)|`[^`]+`/g,
		category: "command_execution",
		severity: "medium",
		description: "Shell command substitution",
	},
];

/**
 * Encoding suspicious patterns
 * Attempts to hide injection via encoding or obfuscation
 */
export const ENCODING_SUSPICIOUS_PATTERNS: PatternDefinition[] = [
	{
		id: "base64_instruction",
		pattern: /(?:decode|base64)\s*[:(]\s*[A-Za-z0-9+/=]{20,}/gi,
		category: "encoding_suspicious",
		severity: "high",
		description: "Base64 encoded content with decode instruction",
	},
	{
		id: "hex_escape_sequence",
		pattern: /(?:\\x[0-9a-fA-F]{2}){4,}/g,
		category: "encoding_suspicious",
		severity: "medium",
		description: "Hex escape sequence (potential obfuscation)",
	},
	{
		id: "unicode_escape_sequence",
		pattern: /(?:\\u[0-9a-fA-F]{4}){4,}/g,
		category: "encoding_suspicious",
		severity: "medium",
		description: "Unicode escape sequence (potential obfuscation)",
	},
	{
		id: "html_entity_abuse",
		pattern: /(?:&#\d{2,4};){4,}|(?:&#x[0-9a-fA-F]{2,4};){4,}/gi,
		category: "encoding_suspicious",
		severity: "medium",
		description: "HTML entity encoding (potential obfuscation)",
	},
	{
		id: "rot13_mention",
		pattern: /rot13|caesar\s+cipher|decode\s+this/gi,
		category: "encoding_suspicious",
		severity: "low",
		description: "Mention of simple encoding schemes",
	},
	{
		id: "leetspeak_injection",
		pattern: /1gn0r3|f0rg3t|byp4ss|syst3m|4dm1n|h4ck/gi,
		category: "encoding_suspicious",
		severity: "medium",
		description: "Leetspeak obfuscation of injection keywords",
	},
];

/**
 * Prompt leaking patterns
 * Attempts to extract system prompt or internal configuration
 */
export const PROMPT_LEAKING_PATTERNS: PatternDefinition[] = [
	{
		id: "reveal_system_prompt",
		pattern: /reveal\s+(your\s+)?(system\s+)?prompt/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to reveal system prompt",
	},
	{
		id: "show_instructions",
		pattern: /show\s+(?:me\s+)?(?:your\s+)?(?:(?:initial|original|system|hidden)\s+)?instructions?/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to show hidden instructions",
	},
	{
		id: "print_above",
		pattern: /print\s+(everything|all|text)\s+(above|before)/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to print content above current context",
	},
	{
		id: "repeat_back",
		pattern: /repeat\s+(back\s+)?(everything|all|your\s+instructions?)/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to make AI repeat instructions",
	},
	{
		id: "what_are_your_instructions",
		pattern: /what\s+(are|were)\s+(your|the)\s+(?:(?:initial|original|system)\s+)?instructions?/gi,
		category: "instruction_override",
		severity: "medium",
		description: "Question about system instructions",
	},
	{
		id: "output_initialization",
		pattern: /output\s+(your\s+)?(initialization|init|startup|boot)/gi,
		category: "instruction_override",
		severity: "high",
		description: "Attempt to output initialization content",
	},
];

/**
 * Indirect injection patterns
 * Markers that indicate injection in tool outputs (documents, emails, etc.)
 */
export const INDIRECT_INJECTION_PATTERNS: PatternDefinition[] = [
	{
		id: "markdown_hidden_instruction",
		pattern: /\[.*?\]\(.*?(?:ignore|forget|system|instruction).*?\)/gi,
		category: "structural",
		severity: "high",
		description: "Markdown link with hidden injection",
	},
	{
		id: "html_comment_injection",
		pattern: /<!--\s*(?:system|ignore|instruction|prompt).*?-->/gi,
		category: "structural",
		severity: "high",
		description: "HTML comment containing injection keywords",
	},
	{
		id: "invisible_unicode",
		pattern: /[\u200B-\u200D\uFEFF\u2060\u2061\u2062\u2063\u2064]/g,
		category: "encoding_suspicious",
		severity: "medium",
		description: "Invisible Unicode characters (zero-width, etc.)",
	},
	{
		id: "text_direction_override",
		pattern: /[\u202A-\u202E\u2066-\u2069]/g,
		category: "encoding_suspicious",
		severity: "medium",
		description: "Text direction override characters",
	},
	{
		id: "confusable_homoglyphs",
		// Cherokee letters that look like Latin (ᎪᏢᏞᎬ = A, P, L, E lookalikes)
		// Small caps Latin letters (ᴀ-ᴢ range, excluding regular ASCII)
		// Cyrillic lookalikes (а, е, о, р, с, х = a, e, o, p, c, x lookalikes)
		pattern: /[\u13A0-\u13F4]|[\u1D00-\u1D2B]|[\u0400-\u04FF]/g,
		category: "encoding_suspicious",
		severity: "medium",
		description: "Unicode homoglyph characters (Cherokee, Small Caps, Cyrillic)",
	},
	{
		id: "separator_injection",
		pattern: /[-=]{10,}[^-=\n]*(?:system|instruction|ignore)/gi,
		category: "structural",
		severity: "medium",
		description: "Separator followed by injection attempt",
	},
	{
		id: "json_injection",
		pattern: /"(?:system|role|instruction|prompt)"\s*:\s*"/gi,
		category: "structural",
		severity: "medium",
		description: "JSON-style role/instruction injection",
	},
];

/**
 * All patterns combined
 */
export const ALL_PATTERNS: PatternDefinition[] = [
	...ROLE_MARKER_PATTERNS,
	...INSTRUCTION_OVERRIDE_PATTERNS,
	...ROLE_ASSUMPTION_PATTERNS,
	...SECURITY_BYPASS_PATTERNS,
	...COMMAND_EXECUTION_PATTERNS,
	...ENCODING_SUSPICIOUS_PATTERNS,
	...PROMPT_LEAKING_PATTERNS,
	...INDIRECT_INJECTION_PATTERNS,
];

/**
 * Get patterns by category
 */
export function getPatternsByCategory(category: PatternCategory): PatternDefinition[] {
	return ALL_PATTERNS.filter((p) => p.category === category);
}

/**
 * Get patterns by severity
 */
export function getPatternsBySeverity(severity: "low" | "medium" | "high"): PatternDefinition[] {
	return ALL_PATTERNS.filter((p) => p.severity === severity);
}

/**
 * Keywords for fast pre-filtering (before regex)
 * If none of these are present, we can skip expensive regex checks
 */
export const FAST_FILTER_KEYWORDS = [
	// Role markers
	"system:",
	"assistant:",
	"user:",
	"developer:",
	"admin:",
	"instruction",
	"[system]",
	"[inst]",
	"<system>",
	"<assistant>",
	// Override keywords
	"ignore",
	"forget",
	"disregard",
	"override",
	"bypass",
	"disable",
	"stop being",
	"from now on",
	// Role assumption
	"you are now",
	"act as",
	"pretend",
	"roleplay",
	"jailbreak",
	"dan",
	"developer mode",
	"imagine you",
	// Security bypass
	"uncensored",
	"unfiltered",
	"unrestricted",
	"no restrictions",
	"without restrictions",
	// Commands
	"execute",
	"eval(",
	"$(",
	"run the",
	// Encoding/obfuscation
	"base64",
	"decode",
	"\\x",
	"\\u",
	"&#",
	"rot13",
	"1gn0r3",
	"f0rg3t",
	"byp4ss",
	// Prompt leaking
	"reveal",
	"show me your",
	"print everything",
	"print above",
	"repeat back",
	"what are your instructions",
	"output initialization",
	// Indirect injection
	"<!--",
	'"system"',
	'"role"',
	'"instruction"',
];

/**
 * Check if text contains any fast filter keywords (case-insensitive)
 * Used to short-circuit expensive pattern matching
 */
export function containsFilterKeywords(text: string): boolean {
	const lowerText = text.toLowerCase();
	return FAST_FILTER_KEYWORDS.some((keyword) => lowerText.includes(keyword.toLowerCase()));
}
