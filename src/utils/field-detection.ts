/**
 * Field detection utilities for identifying risky fields
 */

import type { RiskyFieldConfig } from "../types";

/**
 * Check if a field name should be sanitized based on configuration
 *
 * @param fieldName - Name of the field to check
 * @param config - Risky field configuration
 * @param toolName - Optional tool name for tool-specific overrides
 * @returns Whether the field should be sanitized
 */
export function isRiskyField(fieldName: string, config: RiskyFieldConfig, toolName?: string): boolean {
	// Check tool-specific overrides first
	if (toolName && config.toolOverrides) {
		const overrideFields = getToolOverrideFields(toolName, config.toolOverrides);
		if (overrideFields) {
			return overrideFields.includes(fieldName);
		}
	}

	// Check exact field names
	if (config.fieldNames.includes(fieldName)) {
		return true;
	}

	// Check field name patterns
	for (const pattern of config.fieldPatterns) {
		if (pattern.test(fieldName)) {
			return true;
		}
	}

	return false;
}

/**
 * Get tool-specific field overrides
 *
 * @param toolName - Tool name to match
 * @param overrides - Override configuration
 * @returns Array of field names or undefined if no match
 */
export function getToolOverrideFields(toolName: string, overrides: Record<string, string[]>): string[] | undefined {
	// Try exact match first
	if (overrides[toolName]) {
		return overrides[toolName];
	}

	// Try wildcard patterns
	for (const [pattern, fields] of Object.entries(overrides)) {
		if (matchesWildcard(toolName, pattern)) {
			return fields;
		}
	}

	return undefined;
}

/**
 * Match a tool name against a wildcard pattern
 *
 * @param toolName - Tool name to check
 * @param pattern - Pattern with optional wildcards (*)
 * @returns Whether the tool name matches
 *
 * @example
 * matchesWildcard('documents_list_files', 'documents_*') // true
 * matchesWildcard('gmail_get_message', 'gmail_*') // true
 */
export function matchesWildcard(toolName: string, pattern: string): boolean {
	// Convert wildcard pattern to regex
	const regexPattern = pattern
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special regex chars
		.replace(/\*/g, ".*"); // Convert * to .*

	const regex = new RegExp(`^${regexPattern}$`);
	return regex.test(toolName);
}
