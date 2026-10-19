/**
 * Layer 3: a Tier 3 provider for any OpenAI-compatible `/chat/completions`
 * endpoint (OpenAI, vLLM, Ollama, OpenRouter, LiteLLM, compatible gateways).
 * Uses `fetch` only.
 */
import type { Tier3Provider } from "../types";
import {
	createLlmTier3Provider,
	type LlmCompletion,
	type LlmCompletionRequest,
	type LlmTier3ProviderOptions,
	VERDICT_JSON_SCHEMA,
} from "./tier3-llm-provider";

export interface OpenAICompatibleTier3Options {
	/** e.g. "https://api.openai.com/v1". `/chat/completions` is appended. */
	baseURL: string;
	/** Omitted: no Authorization header. */
	apiKey?: string;
	model: string;
	headers?: Record<string, string>;
	/** Default "json_schema". Use "none" for servers that support neither. */
	responseFormat?: "json_schema" | "json_object" | "none";
	/** Default 300. Sent as `max_completion_tokens` unless `legacyMaxTokens` is set. */
	maxTokens?: number;
	/** Send `max_tokens` instead of `max_completion_tokens` (older servers). */
	legacyMaxTokens?: boolean;
	/** Not sent unless set (some reasoning models reject it). */
	temperature?: number;
	/** Extra attempts on 429, 5xx and network errors, only while the deadline allows. Default 1. */
	retries?: number;
	prompt?: LlmTier3ProviderOptions["prompt"];
	parse?: LlmTier3ProviderOptions["parse"];
	/** For tests or custom runtimes. Default: globalThis.fetch. */
	fetch?: typeof fetch;
	/** Allow plain http:// to a non-local host. Tool content and the key then travel unencrypted. */
	allowInsecureHttp?: boolean;
}

/** Safety limit when defender sets no deadline (`tier3.timeoutMs` unset). */
const DEFAULT_SAFETY_TIMEOUT_MS = 30_000;
const SAFE_CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function safeCode(value: unknown): string | undefined {
	return typeof value === "string" && SAFE_CODE_RE.test(value) ? value : undefined;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		code: string | undefined,
	) {
		super(`HTTP ${status}${code ? ` ${code}` : ""}`);
	}
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const onAbort = () => {
			clearTimeout(t);
			resolve();
		};
		const t = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});

/** Remove one leading reasoning block; reasoning can quote the content, including planted JSON. */
function stripThinking(text: string): string {
	return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, "");
}

function errorCodeOf(body: unknown): string | undefined {
	const err = (body as { error?: { code?: unknown; type?: unknown } } | undefined)?.error;
	return safeCode(err?.code) ?? safeCode(err?.type);
}

// Error codes that mean the provider refused the content (moderation), which the attacker can cause.
const REFUSAL_CODES = new Set(["content_filter", "content_policy_violation", "invalid_prompt"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Append `/chat/completions` to the path (not the query), and require https except for loopback. */
function chatCompletionsUrl(baseURL: string, allowInsecureHttp: boolean): string {
	let url: URL;
	try {
		url = new URL(baseURL);
	} catch {
		throw new Error("createOpenAICompatibleTier3Provider: `baseURL` is not a valid URL");
	}
	const local = LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) || /^127(\.\d{1,3}){3}$/.test(url.hostname);
	if (url.username || url.password) {
		throw new Error(
			"createOpenAICompatibleTier3Provider: put credentials in `apiKey` or `headers`, not in `baseURL`",
		);
	}
	if (url.protocol === "http:" && !local && !allowInsecureHttp) {
		throw new Error(
			"createOpenAICompatibleTier3Provider: `baseURL` must use https (http is allowed for localhost, or with allowInsecureHttp)",
		);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("createOpenAICompatibleTier3Provider: `baseURL` must be http(s)");
	}
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
	return url.toString();
}

/** Build a Tier 3 provider for an OpenAI-compatible chat completions endpoint. */
export function createOpenAICompatibleTier3Provider(opts: OpenAICompatibleTier3Options): Tier3Provider {
	if (!opts?.baseURL || !opts.model) {
		throw new Error("createOpenAICompatibleTier3Provider: `baseURL` and `model` are required");
	}
	const url = chatCompletionsUrl(opts.baseURL, opts.allowInsecureHttp === true);
	const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
	const responseFormat = opts.responseFormat ?? "json_schema";
	const maxTokens = opts.maxTokens ?? 300;
	const retries = Math.max(0, Math.floor(opts.retries ?? 1));

	const complete = async (req: LlmCompletionRequest): Promise<LlmCompletion> => {
		// Honor the deadline on its own too, so the provider works without defender's signal.
		const budget =
			req.deadline !== undefined ? Math.max(1, Math.ceil(req.deadline - Date.now())) : DEFAULT_SAFETY_TIMEOUT_MS;
		const limit = AbortSignal.timeout(budget);
		const signal = req.signal ? AbortSignal.any([req.signal, limit]) : limit;
		const body = JSON.stringify({
			model: opts.model,
			messages: req.messages,
			[opts.legacyMaxTokens ? "max_tokens" : "max_completion_tokens"]: maxTokens,
			...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
			...(responseFormat === "json_schema"
				? {
						response_format: {
							type: "json_schema",
							json_schema: { name: "tier3_verdict", strict: true, schema: VERDICT_JSON_SCHEMA },
						},
					}
				: responseFormat === "json_object"
					? { response_format: { type: "json_object" } }
					: {}),
		});
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			...opts.headers,
			...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
		};

		for (let attempt = 0; ; attempt++) {
			const canRetry = () =>
				attempt < retries && !signal.aborted && (req.deadline === undefined || Date.now() + 250 < req.deadline);
			let resp: Response;
			try {
				// Never follow redirects: fetch keeps custom auth headers (e.g. Azure `api-key`) and sends
				// the tool content to whatever origin a 3xx points at. "manual" hands back the 3xx, which
				// the !resp.ok branch reports as "HTTP 3xx" without retrying.
				resp = await doFetch(url, { method: "POST", headers, body, signal, redirect: "manual" });
			} catch (err) {
				if (signal.aborted) throw new Error("request aborted");
				if (canRetry()) {
					await sleep(250 * (attempt + 1), signal);
					continue;
				}
				// Network error text can include the URL; report only a safe code.
				const cause = (err as { cause?: { code?: unknown } })?.cause;
				throw new Error(`network error${safeCode(cause?.code) ? ` ${safeCode(cause?.code)}` : ""}`);
			}
			let parsed: unknown;
			try {
				parsed = await resp.json();
			} catch {
				if (signal.aborted) throw new Error("request aborted");
				parsed = undefined;
			}
			if (!resp.ok) {
				const code = errorCodeOf(parsed);
				if (code && REFUSAL_CODES.has(code)) {
					return { text: "", refused: true };
				}
				if ((resp.status === 429 || resp.status >= 500) && canRetry()) {
					await sleep(250 * (attempt + 1), signal);
					continue;
				}
				throw new HttpError(resp.status, code);
			}
			const choice = (
				parsed as {
					choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }>;
				}
			)?.choices?.[0];
			// An empty `choices` array is how some gateways report a safety block, which attacker
			// content can trigger, so it blocks. No `choices` field at all is a transport or proxy
			// fault, so onError decides it.
			const choices = (parsed as { choices?: unknown })?.choices;
			if (Array.isArray(choices) && choices.length === 0) return { text: "", refused: true };
			if (!choice) throw new Error("no choice in reply");
			// Refusals, content filters, truncated and empty replies are unusable verdicts the attacker
			// can cause, so they block rather than fail open.
			const content = typeof choice?.message?.content === "string" ? stripThinking(choice.message.content) : "";
			if (
				choice?.finish_reason === "content_filter" ||
				choice?.finish_reason === "length" ||
				(typeof choice?.message?.refusal === "string" && choice.message.refusal.length > 0) ||
				!content.trim()
			) {
				return { text: "", refused: true };
			}
			const u = (
				parsed as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } }
			).usage;
			const usage =
				typeof u?.prompt_tokens === "number" &&
				typeof u.completion_tokens === "number" &&
				typeof u.total_tokens === "number"
					? {
							promptTokens: u.prompt_tokens,
							completionTokens: u.completion_tokens,
							totalTokens: u.total_tokens,
						}
					: undefined;
			return { text: content, ...(usage ? { usage } : {}) };
		}
	};

	return createLlmTier3Provider({
		complete,
		...(opts.prompt ? { prompt: opts.prompt } : {}),
		...(opts.parse ? { parse: opts.parse } : {}),
	});
}
