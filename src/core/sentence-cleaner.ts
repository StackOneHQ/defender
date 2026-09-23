/**
 * Sentence-level cleaning for the `sanitized` copy.
 *
 * Within a high-risk field, replace each contiguous run of high-scoring
 * sentences with a marker and keep the rest, so a mid-content cut stays visible
 * to consumers that read only `sanitized`. Best-effort only (capped by
 * detection) — callers still gate on `allowed`. Runs after Tier 2 so
 * per-sentence scores are available.
 */

import type { Tier2Classifier } from "../classifiers/tier2-classifier";
import { MAX_TRAVERSAL_DEPTH } from "../config";
import { stripRoleMarkers } from "../sanitizers/role-stripper";
import type { DataBoundary } from "../types";
import { stripBoundaryPatterns, wrapWithBoundary } from "../utils/boundary";

export interface SentenceCleanOptions {
	/** Drop a sentence when its own score is >= this (the high-risk threshold). */
	highRiskThreshold: number;
	/** Wrap the cleaned field with these markers when set (mirrors the sanitizer). */
	boundary?: DataBoundary;
}

/** Inline marker left where a contiguous high-risk run was dropped. */
export const CONTENT_SANITISED_MARKER = "[CONTENT SANITISED]";

async function cleanField(raw: string, tier2: Tier2Classifier, opts: SentenceCleanOptions): Promise<string> {
	const sentences = tier2.splitIntoSentences(raw);
	// A single sentence can't be isolated to a bad part, and benign opaque tokens read
	// as one sentence — leave it untouched; the verdict/`allowed` still gates it.
	if (sentences.length <= 1) return raw;
	const scores = await tier2.classifyChunksBatch(sentences);
	const isHighRisk = (i: number) => (scores[i] ?? 0) >= opts.highRiskThreshold;
	// Nothing dropped — return the field verbatim, never a reconstruction (a
	// rebuilt join can differ from the original and report a spurious change).
	if (!sentences.some((_, i) => isHighRisk(i))) return raw;
	// Collapse each contiguous high-risk run into one marker, keeping surviving
	// sentences in place. All-high field → just the marker.
	const parts: string[] = [];
	let inRun = false;
	sentences.forEach((sentence, i) => {
		if (isHighRisk(i)) {
			if (!inRun) parts.push(CONTENT_SANITISED_MARKER);
			inRun = true;
			return;
		}
		// Strip role markers from survivors as defense-in-depth against a sub-threshold marker.
		parts.push(stripRoleMarkers(sentence).trim());
		inRun = false;
	});
	return parts
		.filter((p) => p.length > 0)
		.join(" ")
		.trim();
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
	// Memoize the cleaned result per object identity. An unguarded recursive walk OOM-crashes on a
	// circular reference; a naive pass/fail guard would instead return a SECOND reference to a shared
	// (non-cyclic) high-risk object UNCLEANED. So: a completed entry returns the SAME cleaned copy for
	// every reference (no leak), and an IN_PROGRESS entry — a true cycle or concurrent re-entry — is
	// broken by returning `undefined` (safe: never a raw, unredacted value; bounds cycles and DAGs).
	const cache = new Map<object, unknown>();
	const IN_PROGRESS = Symbol("in-progress");

	async function walk(value: unknown, path: string, depth: number): Promise<unknown> {
		if (typeof value === "string") {
			const raw = opts.boundary ? stripBoundaryPatterns(value) : value;
			if (!highRiskValues.has(raw)) return value;
			const cleaned = await cleanField(raw, tier2, opts);
			if (cleaned !== raw) changedFields.push(path);
			return opts.boundary ? wrapWithBoundary(cleaned, opts.boundary) : cleaned;
		}
		// Bound the walk like every other traversal (sanitize/extractStrings/serializer): past the
		// depth cap, pass through untouched — never recurse unboundedly.
		if (value === null || typeof value !== "object" || depth > MAX_TRAVERSAL_DEPTH) return value;
		if (cache.has(value)) {
			const memo = cache.get(value);
			return memo === IN_PROGRESS ? undefined : memo;
		}
		cache.set(value, IN_PROGRESS);
		let result: unknown;
		if (Array.isArray(value)) {
			try {
				result = await Promise.all(
					// Read AND walk each element under a guard (via Array.from, which does NOT pre-read
					// the elements): a throwing element getter/Proxy trap skips only that element, not the
					// whole payload. The outer try covers a hostile `length`/index trap.
					Array.from({ length: value.length }, async (_unused, i) => {
						try {
							return await walk(value[i], `${path}[${i}]`, depth + 1);
						} catch {
							return undefined;
						}
					}),
				);
			} catch {
				result = value;
			}
		} else {
			const proto = Object.getPrototypeOf(value);
			// Only descend into PLAIN objects, matching the sanitizer — a non-plain object (Date, Map,
			// class instance, Proxy) is passed through untouched (rebuilding it would corrupt it, e.g. a
			// Date becomes {}, and its getters/traps must not be invoked). Its strings are still DETECTED
			// by Tier 2; only permissive-mode REDACTION of them is skipped (real tool results are JSON,
			// which has no non-plain objects — see ENG-2472 for the key/non-plain coverage follow-up).
			if (proto !== Object.prototype && proto !== null) {
				result = value;
			} else {
				let entries: [string, unknown][];
				try {
					// A throwing getter/Proxy trap during enumeration must not abort cleaning of the WHOLE
					// payload (which would leak a sibling high-risk field unredacted) — skip only this subtree.
					entries = Object.entries(value as Record<string, unknown>);
				} catch {
					cache.set(value, value);
					return value;
				}
				const out: Record<string, unknown> = {};
				for (const [k, v] of entries) out[k] = await walk(v, path ? `${path}.${k}` : k, depth + 1);
				result = out;
			}
		}
		cache.set(value, result);
		return result;
	}

	const cleanedContent = await walk(content, "", 0);
	return { content: cleanedContent, changedFields };
}
