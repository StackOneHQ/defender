import { truncate } from "./text";

const MAX_ERROR_TEXT = 200;
const MAX_INPUT_TEXT = 2000;
// Secret-looking field names. `token` must end the name, so `max_tokens` / `prompt_tokens` stay readable.
const SECRET_NAME = String.raw`(?:[\w-]*(?:key|secret|password|passwd|authorization|cookie)[\w-]*|[\w-]*token\b)`;
// Names whose value may contain spaces (a password, a header with a scheme): redact to the next delimiter.
const SPACED_SECRET_NAME = String.raw`(?:[\w-]*(?:password|passwd|secret)[\w-]*|authorization|proxy-authorization|cookie|set-cookie)`;

/**
 * Make provider error text safe to put in `skipReason` and events: strip URL
 * paths and queries (keys often ride in `?key=`), redact token-shaped strings,
 * and cap the length so echoed prompts or content can't ride along.
 * Best effort: a custom provider should still throw short, fixed messages.
 */
export function redactErrorText(text: string): string {
	// Cap first: the patterns below backtrack on very long word runs.
	const cleaned = truncate(text, MAX_INPUT_TEXT)
		// URLs of any scheme: keep scheme + host only (drops userinfo, path and query).
		.replace(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s?#]*@)?([^/\s?#]+)[^\s]*/gi, "$1://$2")
		.replace(/\b(Bearer|Basic|Token|Digest)\s+\S+/gi, "$1 [redacted]")
		// Quoted pairs, JSON or Python-repr: "name": "value" / 'name': 'value'. The closing quote is
		// optional, so a value cut off or left unterminated is still removed.
		.replace(new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"?`, "gi"), '$1"[redacted]"')
		.replace(new RegExp(`('${SECRET_NAME}'\\s*:\\s*)'(?:[^'\\\\]|\\\\.)*'?`, "gi"), "$1'[redacted]'")
		// Values that may contain spaces: redact up to the next delimiter.
		.replace(new RegExp(`\\b(${SPACED_SECRET_NAME})(\\s*[:=]\\s*)[^&,;"'\\n]+`, "gi"), "$1$2[redacted]")
		.replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[:=]\\s*)[^\\s&,;"']+`, "gi"), "$1$2[redacted]")
		// Token shapes from common providers.
		.replace(/\b(sk|rk|pk)[-_](?:live_|test_)?[A-Za-z0-9_-]{8,}/g, "$1-[redacted]")
		.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza[redacted]")
		.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, "$1[redacted]")
		.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1[redacted]")
		.replace(/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, "xox-[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > MAX_ERROR_TEXT ? `${truncate(cleaned, MAX_ERROR_TEXT - 1)}…` : cleaned;
}
