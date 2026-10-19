<div align="center">

  <a href="https://www.stackone.com/platform/prompt-injection-guard/?utm_source=npm&utm_medium=readme&utm_campaign=banner">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/StackOneHQ/defender/main/assets/banner-dark.svg" />
      <img src="https://raw.githubusercontent.com/StackOneHQ/defender/main/assets/banner-light.svg" alt="Defender by StackOne — Indirect prompt injection protection for MCP tool calls" width="800" />
    </picture>
  </a>

  <p>
    <a href="https://www.npmjs.com/package/@stackone/defender"><img src="https://img.shields.io/npm/v/%40stackone%2Fdefender?style=flat-square&color=047B43&label=npm" alt="npm version" /></a>
    <a href="https://www.npmjs.com/package/@stackone/defender"><img src="https://img.shields.io/npm/dm/%40stackone%2Fdefender?style=flat-square&color=047B43&label=downloads" alt="npm downloads" /></a>
    <a href="https://github.com/StackOneHQ/defender/releases"><img src="https://img.shields.io/github/v/release/StackOneHQ/defender?style=flat-square&color=047B43&label=release" alt="latest release" /></a>
    <a href="https://github.com/StackOneHQ/defender/stargazers"><img src="https://img.shields.io/github/stars/StackOneHQ/defender?style=flat-square&color=047B43" alt="GitHub stars" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/npm/l/%40stackone%2Fdefender?style=flat-square&color=047B43" alt="License" /></a>
    <img src="https://img.shields.io/badge/TypeScript-typed-047B43?style=flat-square" alt="TypeScript" />
    <a href="https://defender.stackone.com?utm_source=npm&utm_medium=readme&utm_campaign=badge"><img src="https://img.shields.io/badge/site-defender.stackone.com-047B43?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iI2ZmZiI+PHBhdGggZD0iTTEyIDFMMyA1djZjMCA1LjI1IDMuOCAxMC4xIDkgMTEgNS4yLS45IDktNS43NSA5LTExVjVsLTktNHoiLz48L3N2Zz4=" alt="Defender site" /></a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/model-22MB-047B43?style=flat-square" alt="Model size: 22MB" />
    <img src="https://img.shields.io/badge/latency-~10ms-047B43?style=flat-square" alt="Latency: ~10ms" />
    <img src="https://img.shields.io/badge/CPU--only-no%20GPU%20needed-047B43?style=flat-square" alt="CPU only" />
    <img src="https://img.shields.io/badge/F1%20Score-90.8%25-047B43?style=flat-square" alt="F1 Score: 90.8%" />
  </p>

</div>

---

Indirect prompt injection defense and protection for AI agents using tool calls (via MCP, CLI or direct function calling). Detects and gates prompt injection attacks hidden in tool results (emails, documents, PRs, etc.) before they reach your LLM.

Defender returns `result.sanitized` — a **sentence-level cleaned** copy of the tool result (high-scoring sentences dropped within high-risk fields) — plus an allow/block verdict. Cleaning is best-effort (capped by detection), so still gate on `result.allowed`. Set `sanitizeContent: false` for pure **detect-and-gate**: `sanitized` is then the content verbatim (no rewriting) and you rely on `allowed`.

## Installation

```bash
npm install @stackone/defender
```

The ONNX model (~22MB) is bundled in the package — no model download needed.

### Requirements

Tier 2 (ML classification) is **on by default** and needs two optional peer dependencies at runtime:

```bash
npm install onnxruntime-node @huggingface/transformers
```

If they're missing, Defender does **not** silently run unprotected. It logs a warning, sets `result.tier2Available === false` (alert on this to detect degraded ML defense), and falls back to Tier 1 pattern detection. To **fail closed** instead — throw when Tier 2 can't load — pass `requireTier2: true` to `createPromptDefense`. To run Tier-1-only intentionally, pass `enableTier2: false`.

## Quick Start

```typescript
import { createPromptDefense } from '@stackone/defender';

// Tier 1 (patterns) + Tier 2 (ML classifier) are both on by default.
// blockHighRisk: true enables the allowed/blocked decision.
const defense = createPromptDefense({
  blockHighRisk: true,
});

// Defend a tool result — ONNX model (~22MB) auto-loads on first call
const result = await defense.defendToolResult(toolOutput, 'gmail_get_message');

if (!result.allowed) {
  console.log(`Blocked: risk=${result.riskLevel}, score=${result.tier2Score}`);
  console.log(`Detections: ${result.detections.join(', ')}`);
} else {
  // Safe to pass result.sanitized to the LLM
  passToLLM(result.sanitized);
}
```

## How It Works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/StackOneHQ/defender/main/assets/demo-dark.svg" />
  <img src="https://raw.githubusercontent.com/StackOneHQ/defender/main/assets/demo-light.svg" alt="Defender flow: a poisoned email with an injection payload is intercepted by @stackone/defender and blocked before reaching the LLM, with riskLevel: critical and tier2Score: 0.97" width="900" />
</picture>

`defendToolResult()` runs a tiered defense pipeline. Tier 1 + Tier 2 are on by default; Tier 3 is opt-in and runs the LLM you choose.

### Tier 1 — Pattern Detection (sync, ~1ms)

Regex-based detection that scores content and escalates risk — it does **not** rewrite the payload:
- **Role markers** — detects `SYSTEM:`, `ASSISTANT:`, `<system>`, `[INST]` markers
- **Injection patterns** — detects phrases like "ignore previous instructions"
- **Encoding** — detects Base64/URL/ROT/Morse-encoded payloads as a risk signal
- **Unicode/leet normalization** — analysis-only (homoglyphs like Cyrillic 'а' → 'a', leetspeak) so obfuscated variants are still detected; the returned content is never normalized
- **Boundary annotation** — opt-in; wraps untrusted content in `[UD-{id}]...[/UD-{id}]` tags when `annotateBoundary: true` is passed to `createPromptDefense`. Off by default; pair with `generateBoundaryInstructions()` in your system prompt if you enable it. This is the recommended structural mitigation.

### Tier 2 — ML Classification (async)

Fine-tuned multi-head MiniLM classifier with sentence-level analysis:
- Splits text into sentences and scores each one (0.0 = safe, 1.0 = injection)
- Fine-tuned MiniLM-L6-v2, int8 quantized (~22MB), bundled in the package — no external download needed
- Bundled model is **multi-head** (variant `minilm-multihead-v5`). The auxiliary head identifies meta-discussion / documentation phrasing — under multi-head mode a chunk blocks only when `main >= mainThr AND aux < auxThr`, so docs that quote injection text aren't over-flagged. Reported on the result as `tier2AuxScore` and `tier2MultiheadBlocked`.
- The bundled model carries calibrated thresholds (`highRiskThreshold ≈ 0.64`) in its `classifier_config.json`; these override library defaults when the model is loaded.
- Catches attacks that evade pattern-based detection
- Latency: ~10ms/sample (after model warmup)

**Benchmark results** (ONNX mode, F1 score at threshold 0.5):

| Benchmark | F1 | Samples |
|-----------|-----|---------|
| Qualifire (in-distribution) | 0.8686 | ~1.5k |
| xxz224 (out-of-distribution) | 0.8834 | ~22.5k |
| jayavibhav (adversarial) | 0.9717 | ~1k |
| **Average** | **0.9079** | ~25k |

### Tier 3 — LLM review (opt-in, bring your own LLM)

An LLM reviews the cases Tier 2 is unsure about, or every tool result. You choose the LLM: OpenAI, Anthropic, Gemini, a local model, or any endpoint you run. Defender sends it a prompt, reads back a `block` / `allow` verdict, and applies your policy. Defender adds no LLM dependencies.

Two modes, set with `defenderMode`:
- **`"cascade"`** (default): T1 → T2 → T3. Tier 3 runs only when the Tier 2 score is in the gray band (default `[0.3, 0.85)`). A `"block"` adds a block. An `"allow"` can undo a Tier 2 block; `allowOverride` controls that.
- **`"tier3_only"`**: the LLM reviews the whole tool result and makes the decision. Tier 1 still runs to fill `detections`, but doesn't block. Large results are split into chunks (≤ `maxTextLength` each, about `maxChunks` of them), and any blocking chunk blocks the call. Content past that ceiling, or past the shared `traversal.maxSize` bound, goes to `onOversize`.

#### Use any OpenAI-compatible endpoint

Works with OpenAI, vLLM, Ollama, OpenRouter, LiteLLM and other compatible gateways:

```typescript
import { createOpenAICompatibleTier3Provider, createPromptDefense } from '@stackone/defender';

const provider = createOpenAICompatibleTier3Provider({
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4.1-mini',
});

const defense = createPromptDefense({
  blockHighRisk: true,
  enableTier3: true,
  tier3: { provider, allowOverride: false, timeoutMs: 5000 },
});
```

Options: `headers`, `responseFormat` (`"json_schema"` by default, or `"json_object"` / `"none"`), `maxTokens`, `temperature` (not sent unless set), `retries` (1 extra attempt on 429 / 5xx / network errors), `prompt`, `parse`. `baseURL` must use https, except for localhost and `127.x.x.x`; set `allowInsecureHttp: true` to send over plain http anyway. Put credentials in `apiKey` or `headers`, not in the URL. A moderation hit (`content_filter`, `invalid_prompt`, an empty `choices` array) counts as a refusal and blocks.

#### Use any other LLM

`createLlmTier3Provider` takes one function that calls your model and returns its text. Defender builds the prompt and parses the reply. For example, with the Anthropic SDK:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { createLlmTier3Provider } from '@stackone/defender';

const anthropic = new Anthropic();

const provider = createLlmTier3Provider({
  complete: async ({ messages, signal }) => {
    const system = messages.find((m) => m.role === 'system')?.content;
    const r = await anthropic.messages.create(
      { model: 'claude-haiku-4-5', max_tokens: 300, system, messages: messages.filter((m) => m.role !== 'system') },
      { signal },
    );
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { text, refused: r.stop_reason === 'refusal' };
  },
});
```

The same shape works with the Vercel AI SDK, LangChain or plain `fetch`. Return `refused: true` when the model refuses or a content filter fires: defender treats that as a block, because an attacker can trigger a refusal on purpose. If you can compute a real P(block), for example from logprobs, return it as `score`.

What defender does for you:
- **Prompt.** `DEFAULT_TIER3_PROMPT` is used unless you pass `prompt`, either `{ system, user }` with `{{content}}`, `{{toolName}}`, `{{userGoal}}` and `{{toolDescription}}` placeholders (all in `user`, which is the untrusted channel; `{{content}}` exactly once), or a function that returns messages. `result.tier3.promptVersion` reports which prompt ran.
- **Delimiting.** The tool output is wrapped in marker lines with a random id per call, so it can't close its own wrapper. Look-alike markers inside it are rewritten. `userGoal` and `toolDescription` are wrapped the same way, and the tool name is cut down to identifier characters.
- **Parsing.** The reply must be exactly one JSON object, `{"decision":"block"|"allow","reason":"..."}`, with one `decision` key. This stops JSON planted in the tool output from choosing the verdict.
- **Unusable replies block.** The attacker can cause these on purpose: a plain-text refusal, prose, two objects, or a reply cut off by the token limit. So they count as a block (`refused: true`), not as a failure. Give reasoning models enough `maxTokens`, or they get cut off and block.

#### Write your own provider

A provider is one method. Use this when you already have a reviewer endpoint with its own prompt and parsing:

```typescript
import { setDefaultTier3Provider, type Tier3Provider } from '@stackone/defender';

const myProvider: Tier3Provider = {
  async classify(text, ctx) {
    const verdict = await callMyReviewer(text, { toolName: ctx?.toolName, signal: ctx?.signal });
    return { decision: verdict.block ? 'block' : 'allow', score: verdict.pBlock };
  },
};
setDefaultTier3Provider(myProvider);   // or pass it as tier3.provider
```

`classify` gets the text to review and `ctx`:
- `toolName`
- `signal` (pass it to your call so timeouts and cancellation stop it)
- `deadline`
- `mode`
- `chunk` (tier3_only)
- `userGoal` / `toolDescription` (when the caller passes them)

In cascade, the text is the Tier 2 chunk that drove the score. In `tier3_only`, it's the tool result as `field: value` lines (nested keys dotted, arrays indexed, records separated by blank lines).

It returns a `Tier3Verdict`:

| Field | Required | Meaning |
|---|---|---|
| `decision` | yes | `"block"` or `"allow"` |
| `score` | no | P(block) in [0, 1]. Used by `blockThreshold`. Must be a real probability, not "confidence in my decision" |
| `refused` | no | The model refused, or the reply was unusable. Always counts as a block |
| `reason` | no | Short explanation. Untrusted: it can quote attacker text |
| `raw`, `latencyMs`, `usage` | no | For logs and metrics |

#### Policy

```typescript
const defense = createPromptDefense({
  blockHighRisk: true,
  enableTier3: true,
  defenderMode: 'cascade',                        // or 'tier3_only'
  tier3: {
    provider,                                     // or setDefaultTier3Provider(...)
    escalationBand: { lower: 0.3, upper: 0.85 },  // cascade: when Tier 3 runs
    allowOverride: true,                          // cascade: can an "allow" undo a Tier 2 block?
    onError: 'tier2',                             // what a failure does
    timeoutMs: 5000,                              // per call; default none
    maxConcurrency: 8,                            // in-flight calls per instance; default unbounded
    maxTextLength: 10000,                         // per call (per chunk in tier3_only)
    maxChunks: 5,                                 // tier3_only
    onOversize: 'skip',                           // tier3_only: 'skip' | 'block' | 'scan_anyway'
    stopOnFirstBlock: false,                      // tier3_only: abort the other chunks after a block
    blockThreshold: 0.622,                        // optional; decide on score instead of the decision word
    includeRaw: true,                             // keep result.tier3.raw
    onEvent: (e) => metrics.record(e),            // one event per call; no content
  },
});
```

**`allowOverride`** (cascade). The judge reads attacker text, so a general-purpose LLM can be talked into `allow`. This setting limits what that `allow` can do:

| Setting | A Tier 3 `allow` when Tier 2 would block |
|---|---|
| `true` (default) | undoes the Tier 2 block |
| `false` | is ignored; Tier 3 can only add blocks |
| `{ maxTier2Score: 0.75 }` | undoes the block only when Tier 2's score (before density damping) is below 0.75 |

Use `false` or `{ maxTier2Score }` until you've tested your judge against text written to fool it. In cascade mode without `decide`, defender logs a one-time warning when `allowOverride` is `true` with a provider from `createLlmTier3Provider` or `createOpenAICompatibleTier3Provider`. An invalid `allowOverride` value warns and falls back to `false`.

**`onError`**. A failure is a throw, a timeout, an invalid verdict from a hand-written provider, or a caller cancellation. Unusable replies from `createLlmTier3Provider` / `createOpenAICompatibleTier3Provider` aren't failures; they block (see above):

| Setting | Cascade | tier3_only |
|---|---|---|
| `"tier2"` (cascade default) | keep Tier 2's verdict | not allowed; uses `"allow"` |
| `"allow"` (tier3_only default) | treat as an `allow` (subject to `allowOverride`) | drop failed chunks; other chunks decide |
| `"block"` | block if Tier 2 rated the payload medium or higher | block if any chunk failed; `onOversize` defaults to `"scan_anyway"` |

Under `"block"`, a missing provider also counts as a failure, in `tier3_only` too (instead of falling back to the cascade). `"allow"` in cascade means anyone who can make Tier 3 fail gets the effect of an `allow`, so pair it with `allowOverride: false` or `{ maxTier2Score }`.

**`decide`**. For cases the options above don't cover, pass a policy function. It runs once per call after Tier 3 ran or failed (in cascade, only when escalated), and returns `"block"`, `"allow"` or `"default"` (use the options above):

```typescript
tier3: {
  decide: ({ tier2, tier3 }) =>
    tier3.ran && tier3.decision === 'allow' && tier2 && tier2.score < 0.9 ? 'allow' : 'default',
}
```

It receives scores and verdict metadata only, never the content, `reason` or `raw`. It must be synchronous. A throw or invalid return falls back to `"default"` and warns once. It can't undo a Tier 1 detection, override `onOversize`, or block when `blockHighRisk` is false.

**Caller context.** A judge decides better when it knows the user's task. Pass it per call:

```typescript
await defense.defendToolResult(toolOutput, 'gmail_get_message', {
  context: { userGoal: 'Summarize my unread mail', toolDescription: 'Returns one email' },
  signal,                                        // optional: cancels in-flight Tier 3 calls
});
```

#### Choosing the operating point (`blockThreshold`)

By default the model's `decision` word decides. That word is the model's argmax, an implicit 0.5 cut that nobody chose, and one that moves whenever the model is retrained.

Set `tier3.blockThreshold` to decide on `verdict.score` (P(block)) instead. The cut becomes an explicit config value: raise it for fewer false positives, lower it for more recall. `0.5` reproduces argmax.

This needs a provider that reports `score` as a real P(block). A model's self-reported "confidence" is not one, so `createLlmTier3Provider` only sets `score` when your `complete` returns it. When `score` is missing, the `decision` is used and defender warns once.

#### What you get back

- `result.tier3` is present when Tier 3 ran or was skipped. Use `"tier3" in result` to check.
- With a verdict, `result.tier3` holds `decision`, `score`, `reason` and the other verdict fields. Otherwise it holds `skipReason`, which is short and redacted.
- `errored: true` marks a real failure, not a planned skip.
- In cascade, `overrideApplied` / `overrideSuppressed` say whether an `allow` undid a Tier 2 block.
- `decidedBy` (`"policy"` or `"options"`) is set when `decide` is configured.
- `allowed` is the final answer. With `allowOverride: false`, `tier3.decision` can be `"allow"` while `allowed` is `false`.
- Defender logs one warning after 20 consecutive provider failures on one instance, which usually means a bad key or model name. Caller cancellations don't count. A separate warning fires after 20 consecutive refusals or unusable replies, which usually means the model doesn't follow the JSON format or runs out of `maxTokens`. Use `onEvent` for proper alerting.
- `maxConcurrency` counts a call until the provider really finishes, even after a timeout, so a slow provider can't exceed it. A call that never finishes gives its slot back after 10 × `timeoutMs`. Waiting for a slot is limited to 10 × `timeoutMs` too, so a deep queue of healthy calls doesn't fail, and a hung provider can't stall callers forever. When the queue is overloaded, `onError` decides: use `"block"` to fail closed.

**Data handling:** Tier 3 sends tool output to the endpoint you configure. Don't log `reason` or `raw` where tool content mustn't go, and don't show them to the agent; set `includeRaw: false` if needed.

### Understanding `allowed` vs `riskLevel`

Use `allowed` for blocking decisions:
- `allowed: true` — safe to pass to the LLM
- `allowed: false` — content blocked (requires `blockHighRisk: true`, which defaults to `false`)

`riskLevel` is diagnostic metadata. It starts at `low` and is escalated by Tier 1 pattern detections, encoding detection, and Tier 2 ML scoring — never reduced within a call. Use it for logging and monitoring, not for allow/block logic.

Risk escalation from detections:

| Level | Detection Trigger |
|-------|-------------------|
| `low` | No threats detected |
| `medium` | Suspicious patterns or role markers detected |
| `high` | Injection patterns or suspicious encoding detected |
| `critical` | Severe injection attempt with multiple high-severity indicators |

## API

### `createPromptDefense(options?)`

Create a defense instance.

```typescript
const defense = createPromptDefense({
  enableTier1: true,            // Pattern detection (default: true)
  enableTier2: true,            // ML classification (default: true) — set false to disable
  blockHighRisk: true,          // Block high/critical content (default: false)
  tier2Fields: ['subject', 'body', 'snippet'], // Scope Tier 2 to specific fields (default: all fields)
  useSfe: false,                // SFE preprocessor — drops metadata/identifier fields before Tier 2 (default: false)
  annotateBoundary: false,      // Wrap sanitized strings in [UD-{id}]...[/UD-{id}] tags (default: false)
  sanitizeContent: true,        // sanitized = sentence-cleaned copy; false = detect-and-gate (sanitized = content verbatim) (default: true)
  defaultRiskLevel: 'low',      // Base risk before escalation (default: 'low')

  // Tier 3 — opt-in LLM classification. See the "Tier 3" section above for full semantics.
  enableTier3: false,           // (default: false)
  defenderMode: 'cascade',      // 'cascade' | 'tier3_only' (default: 'cascade'; ignored unless enableTier3 is true)
  tier3: {
    provider: myProvider,                          // overrides the registry-default provider for this instance
    escalationBand: { lower: 0.3, upper: 0.85 },   // cascade-mode gray band; [lower, upper)
    maxTextLength: 10000,                          // per-call LLM review window (per-chunk cap in tier3_only)
    maxChunks: 5,                                  // (default: 5) tier3_only — target chunks reviewed in parallel
    onOversize: 'skip',                            // (default: 'skip') tier3_only — 'skip' | 'block' | 'scan_anyway'
    blockThreshold: 0.622,                         // (default: unset) decide on score >= threshold, not the model's word
  },
});
```

### `defense.defendToolResult(value, toolName)`

The primary method. Runs Tier 1 + Tier 2 and returns a `DefenseResult`:

```typescript
interface DefenseResult {
  allowed: boolean;                       // Use this for blocking decisions (respects blockHighRisk config)
  riskLevel: RiskLevel;                   // Diagnostic: starts at 'low', escalated by detections (see docs above)
  sanitized: unknown;                     // Tool result to forward — sentence-cleaned copy (content verbatim when sanitizeContent:false); dropped runs leave a `[CONTENT SANITISED]` marker; best-effort, still gate on `allowed`
  detections: string[];                   // Pattern names detected by Tier 1
  fieldsSanitized: string[];              // Fields whose content the cleaner changed in `sanitized` (empty when sanitizeContent:false or no Tier 2); for detections read `detections`/`patternsByField`
  patternsByField: Record<string, string[]>; // Patterns per field
  detectedFieldCount: number;             // Count of fields with a Tier-1 detection (keys of patternsByField); threat-count signal (fieldsSanitized.length no longer tracks this)

  // Tier 2 signals
  tier2Score?: number;                    // ML score that drove the decision (post-density / post-rule)
  tier2RawScore?: number;                 // Raw max-chunk main score, pre-density. Forensics only — do not use for blocking.
  tier2AuxScore?: number;                 // Multi-head auxiliary score for the reported chunk
  tier2MultiheadBlocked?: boolean;        // True when the multi-head rule (main >= mainThr AND aux < auxThr) fired
  tier2SkipReason?: string;               // Reason Tier 2 was skipped (e.g. "No strings extracted")
  maxSentence?: string;                   // The sentence with the highest Tier 2 score

  // Tier 3 verdict — present only when Tier 3 ran (use `"tier3" in result` to probe).
  // Either carries the verdict OR a skipReason when defender wanted to run T3 but couldn't.
  tier3?: { decision: 'block' | 'allow'; score?: number; raw?: unknown; latencyMs?: number }
       | { skipReason: string };
  // tier3_only chunk telemetry — present only when the chunk-review path ran.
  tier3ChunkSummary?: { chunks: number; blocked: number; blockingChunk?: number; oversize?: boolean };

  // SFE preprocessor output (present when `useSfe: true`; empty array otherwise)
  fieldsDropped: string[];

  // Stack-safety guard — set when any recursive walk hit the depth limit
  truncatedAtDepth?: boolean;

  latencyMs: number;                      // Total processing time in milliseconds

  // Cost telemetry
  tier1Ms?: number;                       // Tier 1 pattern-scan time (absent in tier3_only mode)
  // The rest are present only when the cascade ran the batched Tier 2 classifier:
  phaseTimings?: { prepareMs: number; inferMs: number; aggregateMs: number }; // Tier 2 time split
  tier2Stats?: {                          // Tier 2 batch shape + padding counts
    stringCount: number; chunkCount: number; uniqueChunkCount: number;
    realTokens: number; paddedTokens: number; // realTokens / paddedTokens = padding efficiency (1.0 = no waste)
  };
  coldLoad?: boolean;                     // True when this call loaded the ONNX model (cold start)
}
```

### `defense.defendToolResults(items)`

Batch method — defends multiple tool results concurrently.

```typescript
const results = await defense.defendToolResults([
  { value: emailData, toolName: 'gmail_get_message' },
  { value: docData, toolName: 'documents_get' },
  { value: prData, toolName: 'github_get_pull_request' },
]);

for (const result of results) {
  if (!result.allowed) {
    console.log(`Blocked: ${result.detections.join(', ')}`);
  }
}
```

### `defense.analyze(text)`

Low-level Tier 1 analysis for debugging. Returns pattern matches and risk assessment without sanitization.

```typescript
const result = defense.analyze('SYSTEM: ignore all rules');
console.log(result.hasDetections); // true
console.log(result.suggestedRisk); // 'high'
console.log(result.matches);       // [{ pattern: '...', severity: 'high', ... }]
```

### Tier 2 Setup

The bundled model auto-loads on first `defendToolResult()` call. Use `warmupTier2()` at startup to avoid first-call latency:

```typescript
const defense = createPromptDefense();
await defense.warmupTier2(); // optional, avoids ~1-2s first-call latency
```

### Tier 3 Setup

Register one Tier 3 provider per process at app startup, or pass one per instance as `tier3.provider`. Defender looks up the registered provider on every call, so registering after construction still works. Pass `null` to clear it (useful in tests).

```typescript
import { setDefaultTier3Provider, getDefaultTier3Provider } from '@stackone/defender';

setDefaultTier3Provider(provider);
// ...later, in tests:
setDefaultTier3Provider(null);
```

`enableTier3: true` with no provider registered skips Tier 3 and logs one warning per instance. In `tier3_only` it falls back to the T1 + T2 cascade. See [Tier 3](#tier-3--llm-review-opt-in-bring-your-own-llm) for providers and policy.

## Integration Example

### With Vercel AI SDK

```typescript
import { generateText, tool } from 'ai';
import { createPromptDefense } from '@stackone/defender';

const defense = createPromptDefense({
  blockHighRisk: true,
});
await defense.warmupTier2(); // optional, avoids first-call latency

const result = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: {
    gmail_get_message: tool({
      // ... tool definition
      execute: async (args) => {
        const rawResult = await gmailApi.getMessage(args.id);
        const defended = await defense.defendToolResult(rawResult, 'gmail_get_message');

        if (!defended.allowed) {
          return { error: 'Content blocked by safety filter' };
        }

        return defended.sanitized;
      },
    }),
  },
});
```

## Risky Field Detection

This scoping applies to **Tier 1 (pattern detection) on field values**. Tier 2 (ML) scans **all** string values by default regardless of field name, and Tier 1 also scans object **keys** — so the lists below narrow where Tier 1 looks at field *values*, not what Defender inspects overall.

For Tier 1 value scanning, per-tool overrides focus on the fields most likely to carry user-generated or external content:

| Tool Pattern | Scanned Fields |
|---|---|
| `gmail_*`, `email_*` | subject, body, snippet, content |
| `documents_*` | name, description, content, title |
| `github_*` | name, title, body, description, message |
| `hris_*` | name, notes, bio, description |
| `ats_*` | name, notes, description, summary |
| `crm_*` | name, description, notes, content |

Tools not matching any pattern use the default risky field list: `name`, `description`, `content`, `title`, `notes`, `summary`, `bio`, `body`, `text`, `message`, `comment`, `subject`, plus patterns like `*_description`, `*_body`, etc.

Fields like `id`, `url`, `created_at` are outside the Tier 1 risky-field list, so Tier 1 pattern detection skips their values — but Tier 2 still scores them (it scans all strings), so an injection there is not invisible to Defender.

## Development

### Local Development

The bundled models (`*.onnx`, `*.ftz`) are stored with [Git LFS](https://git-lfs.com). Install it before cloning, or run `git lfs install && git lfs pull` in an existing clone — otherwise the model files are ~130-byte pointers and the build fails with a "Git LFS pointer" error (Tier 2 / SFE won't load).

This repo uses [pnpm](https://pnpm.io). The pnpm version is pinned in `package.json` under `packageManager` (Corepack picks it up automatically), and the Node.js version is pinned under `devEngines.runtime` in `package.json` (not `.npmrc`).

pnpm itself needs an existing Node.js to run (unless you installed it via the [standalone installer](https://pnpm.io/installation#using-a-standalone-script)). Once running, pnpm downloads the pinned Node.js version on demand and uses it for `pnpm run` scripts regardless of which Node.js is on your system.

```bash
corepack enable                   # picks up pnpm@<version> from packageManager
pnpm install --frozen-lockfile    # downloads the pinned Node.js on first run
pnpm node --version               # should print the version from devEngines.runtime
```

Use the pnpm version from `packageManager`. Older pnpm releases ran the strict `engines` check *before* downloading the pinned Node.js ([pnpm/pnpm#10033](https://github.com/pnpm/pnpm/issues/10033)), so an unpinned pnpm can fail with `ERR_PNPM_UNSUPPORTED_ENGINE` instead of fetching the right Node.js.

### Building

```bash
pnpm build
```

### Typechecking

```bash
pnpm test:typecheck
```

TypeScript 7 is the compiler for type checks and declaration builds. Both build commands run the source check before tsdown, which uses its native declaration option with the installed compiler’s platform-specific executable. The declaration option is experimental; the separate source check preserves semantic checking because the declaration subprocess uses `--noCheck`.

### Testing

```bash
pnpm test
```

## Defender by StackOne

Defender is built and maintained by [StackOne](https://www.stackone.com?utm_source=npm&utm_medium=readme&utm_campaign=about), the enterprise integration platform for AI agents. We run Defender in production to protect agent tool calls against indirect prompt injection.

- **Defender site** — [defender.stackone.com](https://defender.stackone.com?utm_source=npm&utm_medium=readme&utm_campaign=about)
- **Overview & benchmarks** — [stackone.com/platform/prompt-injection-guard](https://www.stackone.com/platform/prompt-injection-guard/?utm_source=npm&utm_medium=readme&utm_campaign=about)
- **StackOne platform** — [stackone.com](https://www.stackone.com?utm_source=npm&utm_medium=readme&utm_campaign=about)

## License

Apache-2.0 — See [LICENSE](./LICENSE) for details.
