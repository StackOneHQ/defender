/**
 * Structure detection and handling utilities
 */

import type { SanitizableValue, SizeMetrics, StructureType } from "../types";

/**
 * Detect the structure type of a value
 *
 * @param value - Value to analyze
 * @returns Structure type classification
 */
export function detectStructureType(value: unknown): StructureType {
	if (value === null || value === undefined) {
		return "null";
	}

	if (Array.isArray(value)) {
		return "array";
	}

	if (typeof value === "object") {
		const keys = Object.keys(value);

		// Check for common wrapper patterns
		if (keys.includes("data") || keys.includes("results") || keys.includes("items") || keys.includes("records")) {
			return "wrapped";
		}

		return "object";
	}

	return "primitive";
}

/**
 * Check if a value is a paginated response
 *
 * @param value - Value to check
 * @returns Whether the value looks like a paginated response
 */
export function isPaginatedResponse(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj);

	// Common pagination indicators
	const hasDataField = keys.some((k) => ["data", "results", "items", "records"].includes(k));

	const hasPaginationField = keys.some((k) =>
		[
			"next",
			"previous",
			"nextPage",
			"prevPage",
			"pagination",
			"page",
			"total",
			"totalCount",
			"hasMore",
			"cursor",
		].includes(k),
	);

	return hasDataField && hasPaginationField;
}

/**
 * Get the data array from a wrapped/paginated response
 *
 * @param value - Wrapped response object
 * @returns The data array or undefined if not found
 */
export function getWrappedData(value: Record<string, unknown>): unknown[] | undefined {
	const dataKeys = ["data", "results", "items", "records"];

	for (const key of dataKeys) {
		if (Array.isArray(value[key])) {
			return value[key] as unknown[];
		}
	}

	return undefined;
}

/**
 * Create initial size metrics
 */
export function createSizeMetrics(): SizeMetrics {
	return {
		estimatedBytes: 0,
		stringCount: 0,
		objectCount: 0,
		arrayCount: 0,
		sizeLimitHit: false,
		depthLimitHit: false,
	};
}

/**
 * Estimate the size of a value in bytes (without JSON.stringify)
 *
 * This is an incremental estimation to avoid expensive serialization
 *
 * @param value - Value to estimate
 * @returns Estimated size in bytes
 */
export function estimateSize(value: SanitizableValue): number {
	if (value === null || value === undefined) {
		return 4; // 'null'
	}

	if (typeof value === "string") {
		return value.length + 2; // quotes
	}

	if (typeof value === "number") {
		return String(value).length;
	}

	if (typeof value === "boolean") {
		return value ? 4 : 5; // 'true' or 'false'
	}

	if (Array.isArray(value)) {
		// Brackets + commas (rough estimate, actual content counted separately)
		return 2 + Math.max(0, value.length - 1);
	}

	if (typeof value === "object") {
		const keys = Object.keys(value);
		// Braces + colons + commas + key lengths
		const keyOverhead = keys.reduce((sum, k) => sum + k.length + 3, 0); // "key":
		const commaOverhead = Math.max(0, keys.length - 1);
		return 2 + keyOverhead + commaOverhead;
	}

	return 0;
}

/**
 * Update size metrics incrementally during traversal
 *
 * @param metrics - Metrics to update (mutated in place)
 * @param value - Value being processed
 */
export function updateSizeMetrics(metrics: SizeMetrics, value: SanitizableValue): void {
	metrics.estimatedBytes += estimateSize(value);

	if (typeof value === "string") {
		metrics.stringCount++;
	} else if (Array.isArray(value)) {
		metrics.arrayCount++;
	} else if (value !== null && typeof value === "object") {
		metrics.objectCount++;
	}
}

/**
 * Check if we should continue traversal based on limits
 *
 * @param metrics - Current size metrics
 * @param currentDepth - Current recursion depth
 * @param maxSize - Maximum allowed size
 * @param maxDepth - Maximum allowed depth
 * @returns Whether to continue traversal
 */
export function shouldContinueTraversal(
	metrics: SizeMetrics,
	currentDepth: number,
	maxSize: number,
	maxDepth: number,
): boolean {
	if (currentDepth > maxDepth) {
		metrics.depthLimitHit = true;
		return false;
	}

	if (metrics.estimatedBytes > maxSize) {
		metrics.sizeLimitHit = true;
		return false;
	}

	return true;
}

/**
 * Check if a value is a plain object (not array, null, etc.)
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
