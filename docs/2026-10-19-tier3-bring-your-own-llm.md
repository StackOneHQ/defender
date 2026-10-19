# Design: bring-your-own LLM for Tier 3

Status: implemented in ENG-3495 (2026-10-19). Revised after an adversarial review and a self-review; this version matches the code. Package: `@stackone/defender`. TypeScript comes first; the Python package follows the same shape (see "Python port").

## Goal

Users should be able to run any LLM as the Tier-3 reviewer with a few lines of config: OpenAI, Anthropic, Gemini, a local model, or a hosted endpoint. They should also control how much a Tier-3 verdict can change the outcome.

## Non-goals

- Shipping or documenting any particular hosted reviewer. The package stays vendor-neutral.
- New runtime dependencies. There are no LLM SDK dependencies.
- Changing the outcome for existing users. Every new option defaults to today's behavior.

## Today (verified against `origin/main`)

- The extension point is `Tier3Provider.classify(text, ctx?: { toolName? }) => Promise<Tier3Verdict>`. Everything else is up to the user: the prompt, delimiting untrusted content, calling the model, parsing the reply, timeouts and retries.
- **Cascade override.** A Tier-3 `allow` removes the Tier-2 threat for the **whole payload**, not just the escalated chunk. It also drops `riskLevel` back to the Tier-1 level. A `block` raises the result to `high`. Tier-1 detections are never undone (`prompt-defense.ts` ~L1945-1980).
- **Cascade errors.** A provider error, an invalid verdict, or a missing provider leaves Tier 2's verdict in place. A Tier-2 block stays blocked, and a Tier-2 allow stays allowed. `result.tier3.skipReason` records why.
- **`tier3_only` errors.** A failed chunk is dropped and the remaining chunks decide (union of blocks). If every chunk fails, the call is allowed. This is fail-open (~L1322-1330, ~L1472).
- **No timeouts or concurrency limits.** The package enforces no timeout. `tier3_only` sends one call per chunk, all in parallel. `defendToolResults` fans out with `Promise.all`, so there's no limit across calls either.
- **`blockThreshold`.** With a threshold set, `isTier3Block` decides on `score` whenever the score is numeric, and ignores `decision`.
- **Where blocking starts.** Tier 2 decides blocking with the score after density damping (`score * (highCount/total)^0.1` on 3+ strings). In multihead mode it uses the rule `main >= mainThreshold AND aux < auxThreshold` (mainThreshold defaults to 0.5), not `highRiskThreshold`.

## Design overview

```
Layer 3  createOpenAICompatibleTier3Provider({ baseURL, apiKey, model })   fetch only
Layer 2  createLlmTier3Provider({ complete, prompt?, parse? })             prompt + delimiting + parsing + refusal handling
Layer 1  Tier3Provider.classify(text, ctx)                                 contract unchanged, ctx grows
Policy   tier3.{ decide, allowOverride, onError, timeoutMs, maxConcurrency, stopOnFirstBlock, onEvent, includeRaw }
```

## Layer 1: provider contract (additive)

```ts
interface Tier3Context {
  toolName?: string;
  /** Aborted at the deadline or when the result is no longer needed. Providers should pass it on. */
  signal?: AbortSignal;
  /** Absolute deadline (ms since epoch) for this call, when tier3.timeoutMs is set. */
  deadline?: number;
  mode?: "cascade" | "tier3_only";
  chunk?: { index: number; total: number };
  /** Caller-supplied. May contain untrusted text; see "Caller context". */
  userGoal?: string;
  toolDescription?: string;
}

interface Tier3Verdict {
  decision: "block" | "allow";
  /** P(block) in [0, 1]. Only set by providers that can compute a real probability. */
  score?: number;
  /** Model explanation. Untrusted: it can quote attacker text. Truncated to 500 chars. */
  reason?: string;
  /** True when the model refused or a provider content filter fired. decision is "block". */
  refused?: boolean;
  raw?: unknown;
  latencyMs?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}
```

- Existing providers keep compiling and behaving the same.
- There is no verbalized-confidence score. The reason is in "Score" below.

### Caller context

General-purpose judges decide better when they know the user's task. OpenAI Guardrails and LlamaFirewall both check tool output against the user's goal. Defender can't see that goal, so callers pass it in through a per-call options object. The options object leaves room for later fields without another signature change:

```ts
defense.defendToolResult(value, toolName, { context: { userGoal, toolDescription }, signal });
defense.defendToolResults([{ value, toolName, context: { userGoal, toolDescription } }], { signal });
```

- **`signal` is the caller's cancellation.** It's combined with the deadline using `AbortSignal.any`, with a fallback where that function is missing (Node 22 has it).
- **These fields are not trusted.** `toolDescription` comes from the tool or MCP server, so it can be poisoned. `userGoal` can contain text from earlier untrusted turns. Layer 2 delimits them the same way as the content and caps each one at 2,000 chars.

## Layer 2: `createLlmTier3Provider`

```ts
type LlmMessage = { role: "system" | "user"; content: string };

interface LlmCompletionRequest {
  messages: LlmMessage[];
  signal?: AbortSignal;
  /** Absolute deadline (ms since epoch), when defender has one. */
  deadline?: number;
  /** The reply should be one JSON object matching this schema. */
  json: { schema: typeof VERDICT_JSON_SCHEMA };
}

type LlmCompletion =
  | string
  | {
      text: string;
      /** Set when the provider refused or a content filter fired. */
      refused?: boolean;
      /** A probability the caller computed itself (e.g. from logprobs). Passed through as verdict.score. */
      score?: number;
      usage?: Tier3Verdict["usage"];
    };

function createLlmTier3Provider(opts: {
  complete: (req: LlmCompletionRequest) => Promise<LlmCompletion>;
  prompt?: Tier3PromptTemplate | ((input: PromptInput) => LlmMessage[]);
  parse?: (text: string) => { decision: "block" | "allow"; reason?: string };
}): Tier3Provider;
```

Example with the Anthropic SDK:

```ts
const provider = createLlmTier3Provider({
  complete: async ({ messages, signal }) => {
    const system = messages.find((m) => m.role === "system")?.content;
    const user = messages.filter((m) => m.role !== "system");
    const r = await anthropic.messages.create(
      { model: "claude-haiku-4-5", max_tokens: 300, system, messages: user },
      { signal },
    );
    return { text: r.content.map((b) => (b.type === "text" ? b.text : "")).join(""), refused: r.stop_reason === "refusal" };
  },
});
```

The same pattern works with the Vercel AI SDK, LangChain, or plain `fetch`.

### Prompt

```ts
interface Tier3PromptTemplate {
  system: string;   // instructions; trusted
  user: string;     // must contain {{content}} exactly once; system must not contain it
}
```

- **Default:** `DEFAULT_TIER3_PROMPT`, a generic reviewer prompt written for this package. It's exported so users can read and extend it, and it's versioned as `TIER3_PROMPT_VERSION`. Changing the default prompt is a minor-version change that's called out in the changelog. The version is reported in `result.tier3.promptVersion`.
- **The template is split into system and user parts,** so the instructions and the attacker data don't share a channel.
- **Placeholders:**
  - `{{content}}`, `{{toolName}}`, `{{userGoal}}`, `{{toolDescription}}`
  - `\{{` escapes a literal `{{`
  - `{{toolName}}`, `{{userGoal}}` and `{{toolDescription}}` may appear more than once
  - a missing optional field fills as an empty string
  - an unknown placeholder, a missing `{{content}}`, or more than one `{{content}}` throws when the provider is created
  - all placeholders are filled in one pass, so a placeholder inside `userGoal` is never expanded again
- **`toolName` is also third-party text.** The tool or MCP server supplies it. It's filled in sanitized: capped at 128 chars, with control characters and newlines removed and lookalike markers neutralized.
- **Builder functions** get `PromptInput` with **pre-wrapped** fields: `wrappedContent`, `wrappedUserGoal`, `wrappedToolDescription`, and the sanitized `toolName`. A builder has no way to get the content without its wrapper. After the builder runs, the provider checks that the content's markers appear exactly once each, and throws if they don't.

### Delimiting untrusted text (always applied)

1. **No `String.replace(str, str)`.** Its replacement strings interpret `` $` ``, `$'` and `$&`. Filling uses one function-replacer pass.
2. **Symmetric markers with a random id per call:**

   ```
   <<<UNTRUSTED_CONTENT id=7f3a9c1e5b2d8a04>>>
   ...content...
   <<<END_UNTRUSTED_CONTENT id=7f3a9c1e5b2d8a04>>>
   ```

   - The id is 16 hex chars from `crypto.getRandomValues`.
   - The prompt says only the END line with that id ends the content.
   - A guessed id is useless because each call gets a new one.
   - Markers like these are less ambiguous to a model than an XML closing tag with an attribute.
3. **Marker lookalikes in the content are neutralized:**
   - Any run of three `<`-like characters (`<`, full-width `＜`, small `﹤`, with format characters between them ignored) becomes `‹‹‹`.
   - This catches every lookalike, whatever case, spelling or homoglyphs follow, because no marker can start without `<<<`.
   - The rest of the content is left unchanged.
4. **Other caller fields get the same treatment,** each with its own id.

This is the delimiting technique from Microsoft's Spotlighting work. It lowers the risk; it does not remove it. The policy options below are the backstop.

### Parsing

The parser is strict by default, so text the attacker planted can't pick the verdict:

1. Strip one surrounding code fence.
2. The whole reply must be **exactly one JSON object**. Prose around it, multiple objects, or a truncated object is a parse failure.
3. `decision` must be `"block"` or `"allow"` (case-insensitive). `reason` is optional.
4. A parse failure throws. The throw becomes a Tier-3 error, so `onError` decides the outcome.

`parse` can be overridden for models that can't produce strict JSON. The docs say plainly that a looser parser is a security trade-off.

### Refusals and content filters

A judge refusing to review the content, or a provider content filter rejecting it, is something an attacker can trigger. So it can't count as a plain error, and it can't fall into `onError: "allow"`.

- `LlmCompletion.refused: true` gives `decision: "block"`, `refused: true`.
- Layer 3 detects these on its own:
  - `finish_reason: "content_filter"`
  - a non-empty `message.refusal`
  - HTTP 400 with a content-filter error code
- Layer 2 can't recognize SDK-specific refusals. Its `complete` examples show how to set `refused`.

### Score

- **`score` is set only from a real probability.** In layer 2, that's a `score` the user's `complete` returned. A custom layer-1 provider can still set `score` itself, as today.
- **A self-reported "confidence" from the model is not used as `score`.**
  - `isTier3Block` decides on any numeric score once `blockThreshold` is set.
  - An uncalibrated confidence would then quietly override `decision`. A weak "allow, confidence 0.1" would turn into 0.9 and block.
  - The attacker can also influence the confidence the model reports.
- If a model returns `confidence`, it stays in `raw` only.
- Reading P(block) out of a JSON reply's token logprobs is also left out. The decision token can be split across tokens, appear after other keys, or fall outside the top-k. A user who wants this computes it in `complete` and returns `score`.

## Layer 3: `createOpenAICompatibleTier3Provider`

```ts
createOpenAICompatibleTier3Provider({
  baseURL: "https://api.openai.com/v1",     // or vLLM, Ollama, OpenRouter, LiteLLM, compatible gateways
  apiKey?: string,                          // omitted: no Authorization header (never "Bearer undefined")
  model: string,
  headers?: Record<string, string>,
  responseFormat?: "json_schema" | "json_object" | "none",   // default "json_schema"
  maxTokens?: number,                       // default 300; sent as max_completion_tokens, or max_tokens with legacyMaxTokens: true
  temperature?: number,                     // default: not sent (some reasoning models reject it)
  retries?: number,                         // default 1: one extra attempt on 429/5xx/network error, only if the deadline allows
  prompt?, parse?,                          // passed to layer 2
});
```

- `VERDICT_JSON_SCHEMA` lists both `decision` and `reason` as required and sets `additionalProperties: false`. Strict `json_schema` mode requires every property to be listed as required. `reason` may be an empty string.
- **Reasoning models:** the parser uses only `message.content`. `reasoning_content` is ignored, and one leading `<think>…</think>` block is stripped. The reasoning can quote the content, including planted JSON, so it must never reach the parser.
- Non-2xx responses and empty bodies throw, except content filters, which are refusals.
- **Error messages carry only the status code and the provider's error `type` or `code`.** They never include the URL query, headers, the request body, or the response body.
- Anthropic, Gemini and Bedrock are reachable through an OpenAI-compatible gateway, or directly through layer 2.

## Defense policy options

All of these live under `tier3` in `createPromptDefense` options. Each default reproduces today's outcome.

### `allowOverride`: what a Tier-3 `allow` can undo (cascade only)

```ts
allowOverride?: boolean | { maxTier2Score: number };   // default: true
```

First the package computes `tier2WouldBlock`: whether Tier 2 alone would block this payload. That's the multihead rule when multihead is on, otherwise `effectiveScore >= highRiskThreshold`. `allowOverride` only matters when `tier2WouldBlock` is true and the judge returns `allow`.

| Setting | Tier-3 `allow` when Tier 2 would block |
|---|---|
| `true` (default) | removes the Tier-2 threat (today's behavior) |
| `false` | ignored; the payload stays blocked |
| `{ maxTier2Score: x }` | removes the threat only if Tier 2's top-chunk score **before density damping** is below `x` |

- **When `tier2WouldBlock` is false,** Tier 2 wasn't going to block. A Tier-3 `allow` changes nothing, and a Tier-3 `block` adds a block under every setting.
- **Which score `x` is compared with.** In single-head mode, it's the top chunk's score before density damping. In multihead mode, it's the main-head score of the top blocking chunk; multihead has no damping. When the aux head vetoes the block, `tier2WouldBlock` is false and the setting doesn't come into play.
- **Damping is skipped on purpose.** Density damping can be pushed down by padding the payload with benign strings. Comparing with the damped score would let an attacker move a confident Tier-2 block into the range the judge is allowed to undo.
- **Validation:** `x` must satisfy `0 < x <= 1`. An invalid value warns and falls back to `true`, the same pattern as `escalationBand`.
- **No "this is a no-op" warning.** In multihead mode blocks start at `mainThreshold`, not `highRiskThreshold`, so a warning keyed to either would be wrong in some setups.
- **`tier3_only`:** the setting doesn't apply. The package warns once if it's set there.
- **New result fields** say what happened:
  - `result.tier3.overrideApplied: boolean`: the `allow` removed a Tier-2 threat.
  - `result.tier3.overrideSuppressed: boolean`: the `allow` was ignored because of this setting.
  - The README must stop calling `result.tier3.decision` "authoritative". With `allowOverride: false`, `decision` can be `"allow"` while `allowed` is `false`. `allowed` is the final answer.
- **Whole-payload scope.** The override covers the whole payload: one `allow` on the top chunk clears the Tier-2 threat for all strings. That's today's behavior, now documented. Making the override per chunk is out of scope here (see open questions).

### `onError`: what a Tier-3 failure does

A Tier-3 failure is any of these: a throw, a timeout, an invalid verdict, a parse failure, an exhausted retry, or a missing provider when the setting is `"block"`.

```ts
onError?: "tier2" | "allow" | "block";   // default: "tier2" in cascade, "allow" in tier3_only (today)
```

**Cascade:**

| Setting | On failure |
|---|---|
| `"tier2"` (default) | keep Tier 2's verdict (today) |
| `"allow"` | treat as a Tier-3 `allow`, subject to `allowOverride`. **Warning:** anyone who can make Tier 3 fail (a slow, huge or odd payload) gets the same effect as a judge `allow`. Use it only with `allowOverride: false` or `{ maxTier2Score }`, or when availability matters more than this risk. |
| `"block"` | block only if Tier 2 flagged the payload at medium risk or above; otherwise keep Tier 2's allow |

Forcing a block on every escalated payload would turn a Tier-3 outage into a flood of false positives across the whole gray band.

**`tier3_only`:**

| Setting | On failure |
|---|---|
| `"allow"` (default) | drop the failed chunks; any chunk-level `block` still blocks (today) |
| `"block"` | block if any chunk failed. If `onOversize` is unset, it defaults to `"scan_anyway"`, so the unreviewed overflow isn't an open door. Chunks overlap by up to 500 chars, so a single failed chunk blocks the call, even when other chunks covered most of its text. |
| `"tier2"` | not valid in this mode; warns and uses `"allow"` |

**In both modes:**
- `blockHighRisk: false` never blocks, the same invariant as `onOversize`.
- **Missing provider:** with `onError: "block"`, a missing provider counts as a failure. With any other setting, it stays a one-time warning plus `skipReason` (today).
- No separate startup warning: the existing one-time missing-provider warning fires on first use.
- **Failures are flagged separately:** `result.tier3.errored = true` marks a real Tier-3 failure. Planned skips don't set it: a missing provider under the default setting, or chunks aborted by `stopOnFirstBlock`. `skipReason` still gives the text.

### `timeoutMs`

```ts
timeoutMs?: number;   // default: undefined (no package timeout, today)
```

- The deadline is set per `classify` call. The clock starts when the call gets a concurrency slot, not when it's queued.
- At the deadline the package aborts `ctx.signal` and stops waiting. The call becomes a Tier-3 failure.
- The losing promise always gets a `.catch` handler attached, so a provider that ignores the signal and rejects later can't trigger an unhandled rejection. Node 22's default mode would otherwise crash the process.
- A result that arrives late is ignored.
- **One source of truth.** Layers 2 and 3 have no timeout option of their own. They read `ctx.deadline` and `ctx.signal`. When `timeoutMs` is unset, layer 3 applies a 30 s safety limit and documents it.
- Aborting doesn't stop work already running on the provider's side, so the cost is still incurred. This is documented.

### `maxConcurrency`

```ts
maxConcurrency?: number;   // default: unbounded (today)
```

- One semaphore per `PromptDefense` **instance**, shared by every `defendToolResult` and `defendToolResults` call and by both modes.
- A per-call cap would be useless here, because `defendToolResults` fans out with `Promise.all`.
### `stopOnFirstBlock`

```ts
stopOnFirstBlock?: boolean;   // tier3_only; default: false (today)
```

- When set, the first chunk `block` aborts the other in-flight and queued chunk calls. The verdict is already decided by the union-of-blocks rule.
- **Off by default.** `allowed` stays the same, but `tier3ChunkSummary` counts (reviewed, blocked) would be lower than today.
- **Aborted chunks aren't failures.** They're counted as "not needed". They never trigger `onError`, and they don't set `coverageDegraded`.

### `onEvent` (observability)

```ts
onEvent?: (e: Tier3Event) => void;
// { kind: "verdict" | "refusal" | "error" | "timeout" | "missing_provider" | "policy_error", mode, chunk?, latencyMs?, usage?, errorCode? }
```

- The hook is called synchronously and its exceptions are swallowed.
- It lets operators alert on a broken Tier 3, such as a wrong key or an exhausted quota. Today that looks the same as "everything allowed".
- Event payloads never include the content, `reason` or `raw`.
- **Loud log without a hook:** after 20 consecutive Tier-3 failures on one instance, the package logs one warning with the latest `errorCode`, and a success re-arms it. That catches a setup that never works, such as a model that rejects every request.
- **No circuit breaker that stops calling the provider.** Skipping Tier 3 changes verdicts, so that's the operator's call, made through `onEvent`.

### `decide`: custom policy function

For cases the typed options don't cover:

```ts
decide?: (input: Tier3DecisionInput) => "block" | "allow" | "default";

interface Tier3DecisionInput {
  mode: "cascade" | "tier3_only";
  tier1: { detected: boolean; riskLevel: RiskLevel };
  tier2?: {
    wouldBlock: boolean;     // tier2WouldBlock, as defined under allowOverride
    score: number;           // top-chunk score before density damping
    effectiveScore: number;  // score used for escalation and blocking
    auxScore?: number;       // multihead only
    multihead: boolean;
  };
  tier3:
    | { ran: true; decision: "block" | "allow"; score?: number; refused: boolean; unreviewedChunks?: number }
    | { ran: false; errored: boolean; skipReason: string };
  toolName?: string;
}
```

- **When it's called:** once per `defendToolResult`, after Tier 3 has run or failed.
  - **Cascade:** only when Tier 3 was invoked, meaning the payload was escalated.
  - **`tier3_only`:** once, with the aggregated verdict.
- **What it decides:** only the Tier-2/Tier-3 part of the outcome. It replaces `allowOverride` and `onError` for that call.
  - `"block"` adds a threat.
  - `"allow"` removes the Tier-2 threat.
  - `"default"` uses the typed options, so a function can handle a few special cases and pass the rest through.
- **What it can't change:**
  - Tier-1 detections still block.
  - `blockHighRisk: false` still never blocks.
  - `onOversize` still governs content Tier 3 never reviewed.

  These are the package's hard guarantees. A policy function shouldn't be able to switch them off by accident.
- **Synchronous only.** It runs on the hot path, and keeping it sync keeps the timeout and concurrency rules simple. A user who needs async data can precompute it.
- **If it throws or returns anything else,** the package uses `"default"`, warns once, and emits an `onEvent` of kind `"policy_error"`. A buggy policy then falls back to the documented behavior instead of failing open.
- **The input is metadata only.** It never includes the content, `reason` or `raw`. The policy can't be steered by attacker text, and it isn't tempted to parse that text.
- **Reporting:** the result says what decided the outcome, as `result.tier3.decidedBy: "policy" | "options"`.

### `includeRaw`

```ts
includeRaw?: boolean;   // default: true (today: raw is passed through)
```

- `false` drops `raw` from `result.tier3`. `raw` is the full provider response and can quote tool content or attacker text. Use `false` when results are logged or shown downstream.

### Error text hygiene (core, all providers)

`skipReason` and event `errorCode` are built from provider errors **inside the core**. The same rules therefore apply to user-written providers, layer 2 and layer 3:

- capped at 200 chars
- URLs reduced to scheme + host
- anything that looks like `Bearer …`, `key=…` or `sk-…` is redacted
- no echo of provider-returned values. `validateTier3Verdict` stops interpolating `JSON.stringify(decision)`.

## Security notes for the README

- **The judge reads attacker text.** A general-purpose LLM can be talked into `allow`. Recommend `allowOverride: false` or `{ maxTier2Score }` until the judge has been tested against manipulation aimed at itself. When `allowOverride` is `true` and a provider created by layer 2 or 3 is in use, the package logs a one-time warning.
- **`tier3_only` makes the judge the only decision-maker.** Don't use it with an untested judge.
- **`reason` and `raw` are model output and can quote attacker text.** Don't show them to the agent or put them in prompts.
- **Tool content goes to whatever endpoint is configured.** That's the user's data-handling decision.

## Backward compatibility

- With no new options set, results are identical to today. That includes cascade errors keeping Tier 2's verdict, `tier3_only` dropping failed chunks, no timeout, and unbounded concurrency.
- The new optional fields on `Tier3Context` and `Tier3Verdict` don't break existing providers. A provider that spreads `ctx` into a request body will now send extra fields. That's noted in the changelog, and the new `signal` field isn't serializable.
- The `defendToolResult` options argument is optional.
- One wording change: the README no longer says `result.tier3.decision` is authoritative. `allowed` always was the final answer.
- **Not identical: `skipReason` text.** Error text hygiene changes the wording, because `validateTier3Verdict` stops echoing provider values. Anyone matching on `skipReason` strings must update. The changelog says so.
- **New log lines only:** the warning for `allowOverride: true` with a layer-2 or layer-3 provider, and the 20-failure warning. Neither changes results.
- New optional result fields: `tier3.decidedBy`, `tier3.errored`, `tier3.refused`, `tier3.overrideApplied`, `tier3.overrideSuppressed`, `tier3.promptVersion`.
- New exports:
  - `createLlmTier3Provider`
  - `createOpenAICompatibleTier3Provider`
  - `DEFAULT_TIER3_PROMPT`
  - `TIER3_PROMPT_VERSION`
  - `VERDICT_JSON_SCHEMA`
  - `parseVerdictJson`
  - types: `Tier3Context`, `Tier3Event`, `Tier3PromptTemplate`, `Tier3DecisionInput`

## Testing

**Delimiting**
- Content containing:
  - `` $` ``, `$'` and `$&`
  - the real marker with a wrong id
  - lookalike markers: lowercase, full-width `＜`, zero-width characters between the `<`s
  - every placeholder string
- Placeholder strings inside `userGoal`, `toolDescription` and `toolName` aren't expanded.
- `toolName` with newlines or markers comes out sanitized.
- A template with `{{content}}` in `system` throws.
- A builder that drops the wrapper throws.

**Parsing**
- Exactly-one-object succeeds.
- These all fail:
  - prose around the object
  - two objects
  - attacker JSON echoed before the model's object
  - a truncated object
  - a bad decision value

**Refusals**
- `refused: true` gives a block.
- Layer 3 recognizes all three content-filter forms.

**`allowOverride`**
- `decide`: each return value, in both modes. A throw or an invalid return falls back to `"default"` and warns once. A Tier-1 detection still blocks when the function returns `"allow"`, and so does an `onOversize` block. The function never receives content, `reason` or `raw`. `decidedBy` is set correctly.
- `errored` is set for real failures only, not for planned skips or `stopOnFirstBlock` aborts.
- `includeRaw: false` removes `raw`.
- The 20-failure warning fires once and re-arms after a success.
- `{ maxTier2Score }` is compared with the score before damping in single-head, and with the top blocking main score in multihead.
- Each setting, against:
  - single-head scores below, inside and above the band
  - a multihead block with aux near the veto
  - a density-flood payload, where damped < x <= undamped, so the `allow` must be ignored
- Tier 1 is never undone.
- `overrideApplied` and `overrideSuppressed` are set exactly as specified.

**`onError`**
- Each failure kind, under each setting, in each mode, with `blockHighRisk` on and off.
- A cascade error with Tier 2 already blocking keeps the block under `"tier2"`.
- Interaction with `allowOverride` under `"allow"`.

**Timeouts**
- Late resolve is ignored.
- Late reject causes no unhandled rejection.
- A provider that ignores the signal is still released at the deadline.
- Queue wait doesn't count against the deadline.

**Concurrency**
- Peak in-flight count is at most `maxConcurrency` across a 100-item `defendToolResults` call.
- `stopOnFirstBlock` aborts the rest. The aborted chunks don't trigger `onError: "block"` or set `coverageDegraded`. With the option off, the counts match today.

**Layer 3, against a mock server**
- 2xx, 4xx, 5xx, 429 with retry, an empty body, and `json_schema` vs `none`.
- `max_completion_tokens` is sent, with no `temperature` by default.
- `reasoning_content` is ignored, and a leading `<think>` block is stripped.
- A planted JSON object inside the reasoning never parses.
- No `Authorization` header when there's no key.
- Error text contains no key, query or body.

**Compatibility**
- An existing provider with a `classify(text, ctx)` that ignores the new fields behaves the same.
- The existing Tier-3 spec suite passes unchanged.

## Python port

The Python package follows the same shape (layers, policy options, defaults). The traps that are different in Python:

- `re.sub` replacement strings interpret backreferences. Use a function replacement.
- The random id comes from `secrets.token_hex`.
- Unicode normalization uses `unicodedata.normalize("NFKC")`.
- The async model is asyncio, with `asyncio.timeout` and a semaphore.

A shared test corpus of prompts, delimiting cases and parse cases is checked into both repos to keep them in sync.

## Rollout

1. **Minor release of the package:** policy options, the layer 1 additions, layers 2 and 3, error hygiene, tests, and the README section.
2. **ENG-3495 README rewrite:** "Bring your own LLM", on the new API.
3. **Python parity:** its own ticket.
4. **Moving internal providers to layer 3:** optional and separate.

## Deferred (not in v1)

- **Response caching.** An LRU keyed by `hash(promptVersion, model, content)`, with errors never cached. Worth adding once there's usage data.
- **Per-call cost budget**, such as a max total chars or tokens per `defendToolResult`.
- **Per-chunk override scope in cascade.**

## Open questions

1. **Should `allowOverride` default to `false` in the next major?** It's the safer default for new users with general-purpose judges, but it changes behavior for existing users.
2. **Is the strict JSON parser too strict for small local models?** If so, the docs could ship a "lenient" parser recipe and keep strict as the default.
3. **Should `stopOnFirstBlock` default to `true` in the next major?** It's cheaper and gives the same verdict; only the counts change.

## Changes after the PR review (#106)

Two adversarial reviews of the implementation led to these changes. The sections above describe the original plan; where they differ, this list wins.

- **Unusable replies block.** A parse failure, an empty reply, `finish_reason: "length"`, or a plain-text refusal becomes `decision: "block"`, `refused: true`. They no longer go through `onError`. The attacker could cause any of them on purpose, and in `tier3_only` the default `onError` would have allowed them.
- **Duplicate `decision` keys are rejected.** `JSON.parse` keeps the last one.
- **`toolName` is cut down to identifier characters** (`[A-Za-z0-9_.:/-]`) instead of being free text.
- **Concurrency slots.** A timed-out call keeps its slot until the provider settles, so `maxConcurrency` holds even with providers that ignore the abort signal. Waiting for a slot is also limited (see the third review below for the final bound), so a hung provider can't stall every caller.
- **`callTier3` never throws.** A verdict with throwing getters is a provider failure.
- **The failure streak is per instance.** Caller cancellations don't count toward it.
- **`stopOnFirstBlock` with `decide`.** `decide` gets `tier3.unreviewedChunks`. If the call ends up allowed with aborted chunks, `coverageDegraded` is set.
- **Caller context can't overwrite `toolName`, `mode` or `chunk`.** Only `userGoal` and `toolDescription` are copied.
- **Redaction covers more patterns:**
  - header and JSON secrets
  - `Basic` auth
  - Google `AIza` keys
  - URL userinfo
  - serialization and Tier-1 error text

  Input is capped before matching.
- **No separate startup warning.** The existing one-time missing-provider warning covers that case.

### Changes after the bot review (cubic)

- `system` may not contain any placeholder; all untrusted fields go in `user`.
- Collapsing the blank lines left by empty optional fields no longer touches the content.
- The duplicate-key check reads the JSON, so an escaped `"deci\u0073ion"` is caught too.
- Layer 3 appends `/chat/completions` to the URL path, so a `baseURL` with a query string still works.
- Layer 3 requires https, except for loopback hosts. `allowInsecureHttp: true` opts out.
- Layer 3 also honors `deadline` without a signal.
- A 2xx with no `choices` is a provider fault: it throws, and `onError` decides it. It does not count as a block.
- An invalid `allowOverride` falls back to `false`, not `true`.
- `timeoutMs` is rounded up to whole milliseconds.
- A call that never settles gets its slot back after 10 × `timeoutMs`.
- In `tier3_only`, `onError: "block"` with no provider fails closed instead of falling back to the cascade.
- Redaction removes quoted secrets even when the closing quote is missing.

**Backward compatibility, restated.** With no new options, existing hand-written providers give the same results as before. The "unusable reply blocks" rule applies only to the new `createLlmTier3Provider` / `createOpenAICompatibleTier3Provider`. The only change existing users see is the text of `skipReason`, which is now redacted.

### Changes after the third adversarial review

- **The slot wait is limited to 10 × `timeoutMs`, not `timeoutMs`.** With the tighter limit, a large payload sent to a healthy but slow judge made its late chunks fail. In `tier3_only` that fails open, so a late-chunk injection got through. The wait now uses the same limit after which a hung call gives its slot back. Overload goes to `onError`.
- **More moderation responses count as refusals and block.** These are HTTP 400 `invalid_prompt` and a 2xx with an empty `choices` array (a gateway safety block). A body with no `choices` field at all still goes to `onError`.
- **Refusals and unusable replies no longer reset the failure streak.** They have their own warning after 20 in a row, so a model that can't follow the format shows up instead of silently blocking everything.
- **`timeoutMs` is capped,** so 10 × `timeoutMs` fits a `setTimeout` delay.
- **Loopback means `localhost`, `::1`, or a dotted-quad `127.x.x.x`.** `127.evil.com` is rejected. Credentials in `baseURL` are rejected. An existing `/chat/completions` path isn't doubled.
- **Redaction handles escaped quotes,** and no longer redacts `max_tokens`-style names.
- **`tier3_only` + `onError: "block"` with no provider warns once and emits `missing_provider`.**

