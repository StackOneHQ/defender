const MAX_ERROR_TEXT = 200;
const MAX_INPUT_TEXT = 2000;
// Secret-looking field names. `token` must end the name, so `max_tokens` / `prompt_tokens` stay readable.
const SECRET_NAME = String.raw`(?:[\w-]*(?:key|secret|password|authorization)[\w-]*|[\w-]*token\b)`;

/**
 * Make provider error text safe to put in `skipReason` and events: strip URL
 * paths and queries (keys often ride in `?key=`), redact token-shaped strings,
 * and cap the length so echoed prompts or content can't ride along.
 */
export function redactErrorText(text: string): string {
	// Cap first: the patterns below backtrack on very long word runs.
	const cleaned = text
		.slice(0, MAX_INPUT_TEXT)
		// URLs: keep scheme + host only (drops userinfo, path and query).
		.replace(/\b(https?):\/\/(?:[^@/\s?#]*@)?([^/\s?#]+)[^\s]*/gi, "$1://$2")
		.replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [redacted]")
		// "name": "value" and name=value / name: value, for secret-looking names.
		// The closing quote is optional, so a value cut off or left unterminated is still removed.
		.replace(new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"?`, "gi"), '$1"[redacted]"')
		.replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[:=]\\s*)[^\\s&,;"]+`, "gi"), "$1$2[redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
		.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > MAX_ERROR_TEXT ? `${cleaned.slice(0, MAX_ERROR_TEXT - 1)}…` : cleaned;
}
