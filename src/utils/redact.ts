import { truncate } from "./text";

const MAX_ERROR_TEXT = 200;
const MAX_INPUT_TEXT = 2000;
// Secret-looking field names. Bounded repeats keep matching linear on hostile input. `token`, `pass`
// and `pwd` must end the name, so `max_tokens` / `prompt_tokens` / `passed` stay readable.
const SECRET_NAME = String.raw`(?:[\w-]{0,40}(?:key|secret|password|passwd|passphrase|credentials?|authorization)[\w-]{0,40}|[\w-]{0,40}(?:token|pass|pwd)\b)`;
// Password-like names, whose values may contain spaces: redact to the next delimiter.
const SPACED_SECRET_NAME = String.raw`(?:[\w-]{0,40}(?:password|passwd|passphrase)[\w-]{0,40}|pass|pwd)`;
// A credential after an auth scheme: long enough and token-shaped, so prose like "Token limit" stays.
const CREDENTIAL = "[A-Za-z0-9._~+/=-]{12,}";

/**
 * Make provider error text safe to put in `skipReason` and events: strip URL
 * paths and queries (keys often ride in `?key=`), redact token-shaped strings,
 * and cap the length so echoed prompts or content can't ride along.
 * Best effort: a custom provider should still throw short, fixed messages.
 */
export function redactErrorText(text: string): string {
	// Cap first: bounded input keeps every pattern below cheap.
	const cleaned = truncate(text, MAX_INPUT_TEXT)
		.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[redacted-private-key]")
		// URLs of any scheme: keep scheme + host only (drops userinfo, path and query). Userinfo runs to
		// the last `@`, so a password containing `@` doesn't leak into the host.
		.replace(/\b([a-z][a-z0-9+.-]*):\/\/(?:[^/\s?#]*@)?([^/@\s?#]+)[^\s]*/gi, "$1://$2")
		// Bearer/Basic are always followed by a credential. "Token"/"Digest" are also ordinary words, so
		// they need a credential-shaped value (keeps "Token limit exceeded" readable).
		// A quoted value whole, else stop at a quote or comma so the next pair in a dict repr stays matchable.
		.replace(/\b(Bearer|Basic)\s+(?:"[^"]*"?|'[^']*'?|[^\s'",]+)/gi, "$1 [redacted]")
		.replace(new RegExp(`\\b(Token|Digest)\\s+${CREDENTIAL}`, "gi"), "$1 [redacted]")
		.replace(
			new RegExp(`\\b(authorization|proxy-authorization)(\\s*[:=]\\s*)(?:[A-Za-z]+\\s+)?${CREDENTIAL}`, "gi"),
			"$1$2[redacted]",
		)
		.replace(/\b(cookie|set-cookie)(\s*:\s*)(?:[\w.-]+=[^;\s]*(?:;\s*)?)+/gi, "$1$2[redacted]")
		// Quoted pairs, JSON or Python-repr: "name": "value" / 'name': 'value'. The closing quote is
		// optional, so a value cut off or left unterminated is still removed.
		.replace(new RegExp(`("${SECRET_NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"?`, "gi"), '$1"[redacted]"')
		.replace(new RegExp(`('${SECRET_NAME}'\\s*:\\s*)'(?:[^'\\\\]|\\\\.)*'?`, "gi"), "$1'[redacted]'")
		// Unquoted name, quoted value: password: 'x' / token="x".
		.replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[:=]\\s*)'(?:[^'\\\\]|\\\\.)*'?`, "gi"), "$1$2'[redacted]'")
		.replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[:=]\\s*)"(?:[^"\\\\]|\\\\.)*"?`, "gi"), '$1$2"[redacted]"')
		// Values that may contain spaces: redact up to the next delimiter.
		.replace(
			new RegExp(`\\b(${SPACED_SECRET_NAME})(\\s*[:=]\\s*)[^\\s&,;"'\\[][^&,;"'\\n\\[]*`, "gi"),
			"$1$2[redacted]",
		)
		.replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[:=]\\s*)[^\\s&,;"'\\[]+`, "gi"), "$1$2[redacted]")
		// Token shapes from common providers.
		.replace(/\b(sk|rk|pk)([-_])(?:live_|test_)?[A-Za-z0-9_-]{8,}/g, "$1$2[redacted]")
		.replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza[redacted]")
		.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, "$1[redacted]")
		.replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1[redacted]")
		.replace(/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, "xox-[redacted]")
		.replace(/\bhf_[A-Za-z0-9]{20,}/g, "hf_[redacted]")
		.replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, "glpat-[redacted]")
		.replace(/\bnpm_[A-Za-z0-9]{30,}/g, "npm_[redacted]")
		.replace(/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "SG.[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > MAX_ERROR_TEXT ? `${truncate(cleaned, MAX_ERROR_TEXT - 1)}…` : cleaned;
}
