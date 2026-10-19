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
