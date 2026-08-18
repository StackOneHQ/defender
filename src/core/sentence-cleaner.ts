/**
 * Sentence-level cleaning for the return-both `sanitized` copy.
 *
 * Within a high-risk field, drop the sentences that themselves score high and
 * keep the rest. Best-effort only (capped by detection) — callers still gate on
 * `allowed`. Runs after Tier 2 so per-sentence scores are available.
 */

import type { Tier2Classifier } from "../classifiers/tier2-classifier";
import { stripRoleMarkers } from "../sanitizers/role-stripper";
import type { DataBoundary } from "../types";
import { stripBoundaryPatterns, wrapWithBoundary } from "../utils/boundary";

export interface SentenceCleanOptions {
	/** Drop a sentence when its own score is >= this (the high-risk threshold). */
	highRiskThreshold: number;
	/** Wrap the cleaned field with these markers when set (mirrors the sanitizer). */
	boundary?: DataBoundary;
}

async function cleanField(raw: string, tier2: Tier2Classifier, opts: SentenceCleanOptions): Promise<string> {
	const sentences = tier2.splitIntoSentences(raw);
	// A single sentence can't be isolated to a bad part, and benign opaque tokens read
	// as one sentence — leave it untouched; the verdict/`allowed` still gates it.
	if (sentences.length <= 1) return raw;
	const scores = await tier2.classifyChunksBatch(sentences);
	const kept = sentences.filter((_, i) => (scores[i] ?? 0) < opts.highRiskThreshold);
	// Every sentence flagged — drop them all rather than blocking the field wholesale.
	if (kept.length === 0) return "";
	// Strip role markers from survivors as defense-in-depth against a sub-threshold marker.
	return stripRoleMarkers(kept.join(" ")).trim();
}

export interface CleanResult {
	/** The payload with high-risk leaf strings sentence-cleaned. */
	content: unknown;
	/** Paths of the leaves whose content actually changed (for `fieldsSanitized`). */
	changedFields: string[];
}

/**
 * Clone `content` (already the structurally-protected, optionally boundary-wrapped
 * original) and replace only the leaf strings whose unwrapped value is in
 * `highRiskValues` with a sentence-cleaned version. Reports the paths that
 * actually changed — `sanitizeContent` off or a single-sentence field (left
 * as-is) yields no change and no reported path. Paths follow the sanitizer's
 * convention: `parent.key` for objects, `parent[i]` for arrays.
 */
export async function cleanHighRiskContent(
	content: unknown,
	highRiskValues: Set<string>,
	tier2: Tier2Classifier,
	opts: SentenceCleanOptions,
): Promise<CleanResult> {
	if (highRiskValues.size === 0) return { content, changedFields: [] };

	const changedFields: string[] = [];

	async function walk(value: unknown, path: string): Promise<unknown> {
		if (typeof value === "string") {
			const raw = opts.boundary ? stripBoundaryPatterns(value) : value;
			if (!highRiskValues.has(raw)) return value;
			const cleaned = await cleanField(raw, tier2, opts);
			if (cleaned !== raw) changedFields.push(path);
			return opts.boundary ? wrapWithBoundary(cleaned, opts.boundary) : cleaned;
		}
		if (Array.isArray(value)) return Promise.all(value.map((v, i) => walk(v, `${path}[${i}]`)));
		if (value && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) out[k] = await walk(v, path ? `${path}.${k}` : k);
			return out;
		}
		return value;
	}

	const cleanedContent = await walk(content, "");
	return { content: cleanedContent, changedFields };
}
