const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** An end index ≤ `end` that doesn't split a UTF-16 surrogate pair. */
export function safeEnd(s: string, end: number): number {
	if (end > 0 && end < s.length && isHighSurrogate(s.charCodeAt(end - 1)) && isLowSurrogate(s.charCodeAt(end))) {
		return end - 1;
	}
	return end;
}

/** A start index ≥ `start` that doesn't split a UTF-16 surrogate pair. */
export function safeStart(s: string, start: number): number {
	if (
		start > 0 &&
		start < s.length &&
		isLowSurrogate(s.charCodeAt(start)) &&
		isHighSurrogate(s.charCodeAt(start - 1))
	) {
		return start + 1;
	}
	return start;
}

/** `s.slice(0, max)` without leaving half of a surrogate pair at the cut. */
export function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, safeEnd(s, max)) : s;
}

/** Lower-cased, whitespace collapsed: how a Tier 1 matched phrase is looked up in Tier 2's chunks. */
export function phraseKey(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Non-overlapping occurrences of `needle` (non-empty) in `hay`. */
export function countOf(hay: string, needle: string): number {
	let n = 0;
	for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
	return n;
}
