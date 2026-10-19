const MAX_ERROR_TEXT = 200;

/**
 * Make provider error text safe to put in `skipReason` and events: strip URL
 * paths and queries (keys often ride in `?key=`), redact token-shaped strings,
 * and cap the length so echoed prompts or content can't ride along.
 */
export function redactErrorText(text: string): string {
	const cleaned = text
		.replace(/\b(https?):\/\/([^/\s?#]+)[^\s]*/gi, "$1://$2")
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(api[_-]?key|key|token|access_token)=[^\s&]+/gi, "$1=[redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > MAX_ERROR_TEXT ? `${cleaned.slice(0, MAX_ERROR_TEXT - 1)}…` : cleaned;
}
