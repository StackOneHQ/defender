# Optional LLM review

This reference covers the open source provider adapters for a model you supply. StackOne's hosted Tier 3 model and service are separate and are not bundled in this package. For local Tier 1 + Tier 2 usage and evaluations, see the [README](../README.md).

<a id="tier-3--llm-review-opt-in-bring-your-own-llm"></a>

### Tier 3: LLM review (opt-in, bring your own LLM)

An LLM reviews the cases Tier 2 is unsure about, or every tool result. You choose the LLM: OpenAI, Anthropic, Gemini, a local model, or any endpoint you run. Defender sends it a prompt, reads back a `block` / `allow` verdict, and applies your policy. Defender adds no LLM dependencies.

Two modes, set with `defenderMode`:

- **`"cascade"`** (default): T1 → T2 → T3. Tier 3 runs only when the Tier 2 score is in the gray band (default `[0.3, 0.85)`). A `"block"` adds a block. An `"allow"` can undo a Tier 2 block; `allowOverride` controls that.
- **`"tier3_only"`**: the LLM reviews the whole tool result and makes the decision. Tier 1 still runs to fill `detections`, but doesn't block. Large results are split into chunks (≤ `maxTextLength` each, about `maxChunks` of them), and any blocking chunk blocks the call. Content past that ceiling, or past the shared `traversal.maxSize` bound, goes to `onOversize`.

#### Use any OpenAI-compatible endpoint

Use an endpoint that supports `/chat/completions`, such as OpenAI, vLLM, Ollama, OpenRouter, [OrcaRouter](https://www.orcarouter.ai) (`https://api.orcarouter.ai/v1`) or LiteLLM. Set `OPENAI_API_KEY` and `OPENAI_MODEL` for the example below; adjust `responseFormat` and token options to match your endpoint:

```typescript
import { createOpenAICompatibleTier3Provider, createPromptDefense } from '@stackone/defender';

const provider = createOpenAICompatibleTier3Provider({
  baseURL: 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL!, // Set to a model supported by your endpoint
});

const defense = createPromptDefense({
  blockHighRisk: true,
  enableTier3: true,
  tier3: { provider, allowOverride: false, timeoutMs: 5000 },
});
```

Options: `headers`, `responseFormat` (`"json_schema"` by default, or `"json_object"` / `"none"`), `maxTokens` (default 300, sent as `max_completion_tokens`; `legacyMaxTokens: true` sends `max_tokens`), `temperature` (not sent unless set), `retries` (1 extra attempt on 429 / 5xx / network errors), `prompt`, `parse`, `fetch` (a custom fetch, for tests or other runtimes). `baseURL` must use https, except for localhost and `127.x.x.x`; set `allowInsecureHttp: true` to send over plain http anyway. Put credentials in `apiKey` or `headers`, not in the URL. A moderation hit (`content_filter`, `invalid_prompt`, an empty `choices` array) counts as a refusal and blocks.

#### Use any other LLM

`createLlmTier3Provider` takes one function that calls your model and returns its text. Defender builds the prompt and parses the reply. For example, with the Anthropic SDK and `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` set:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { createLlmTier3Provider } from '@stackone/defender';

const anthropic = new Anthropic();

const provider = createLlmTier3Provider({
  complete: async ({ messages, signal }) => {
    const system = messages.find((m) => m.role === 'system')?.content;
    const r = await anthropic.messages.create(
      {
        model: process.env.ANTHROPIC_MODEL!, // Set to an available model ID
        max_tokens: 300,
        system,
        messages: messages.filter((m) => m.role === 'user').map((m) => ({ role: 'user' as const, content: m.content })),
      },
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
- **Parsing.** The reply must be exactly one JSON object, `{"decision":"block"|"allow","reason":"..."}`, with one `decision` key. The parser rejects extra prose, multiple objects and duplicate decision keys.
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

In cascade, the text is the Tier 2 chunk that drove the score. In `tier3_only`, it's the tool result as `field: value` lines (nested keys dotted, arrays indexed, records separated by blank lines). Keys are reviewed too: an object whose values are only numbers, booleans, `null` or empty values is still reviewed (like any payload, in up to `maxChunks` calls), because its keys can carry injected text.

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
    onEvent: (e) => metrics.record(e),            // one event per call; no content, reason or raw
  },
});
```

**`allowOverride`** (cascade). The judge reads attacker text, so a general-purpose LLM can be talked into `allow`. This setting limits what that `allow` can do:

| Setting | A Tier 3 `allow` when Tier 2 would block |
|---|---|
| `true` (default) | undoes the Tier 2 block |
| `false` | is ignored; Tier 3 can only add blocks |
| `{ maxTier2Score: 0.75 }` | undoes the block only when Tier 2's score (before density damping) is below 0.75 |

Use `false` or `{ maxTier2Score }` until you've tested your judge against text written to fool it. In cascade mode without `decide`, defender logs a warning once per process when `allowOverride` is `true` with a provider from `createLlmTier3Provider` or `createOpenAICompatibleTier3Provider`. An invalid `allowOverride` value warns and falls back to `false`.

**`onError`**. A failure is a throw, a timeout, an invalid verdict from a hand-written provider, or a caller cancellation. Unusable replies from `createLlmTier3Provider` / `createOpenAICompatibleTier3Provider` aren't failures; they block (see above):

| Setting | Cascade | tier3_only |
|---|---|---|
| `"tier2"` (cascade default) | keep Tier 2's verdict | not allowed; uses `"allow"` |
| `"allow"` (tier3_only default) | treat as an `allow` (subject to `allowOverride`) | drop failed chunks; other chunks decide |
| `"block"` | block if Tier 2 rated the payload medium or higher (with the bundled model Tier 2 rarely reports `medium`: its band is [0.5, 0.52)) | block if any chunk failed; `onOversize` defaults to `"scan_anyway"` |

Under `"block"`, a missing provider also counts as a failure, in `tier3_only` too (instead of falling back to the cascade). `"allow"` in cascade means anyone who can make Tier 3 fail gets the effect of an `allow`, so pair it with `allowOverride: false` or `{ maxTier2Score }`.

**`decide`**. For cases the options above don't cover, pass a policy function. It runs once per call after Tier 3 ran or failed (in cascade, only when escalated), and returns `"block"`, `"allow"` or `"default"` (use the options above):

```typescript
tier3: {
  decide: ({ tier2, tier3 }) =>
    tier3.ran && tier3.decision === 'allow' && tier2 && tier2.score < 0.9 ? 'allow' : 'default',
}
```

It receives scores and verdict metadata only, never the content, `reason` or `raw`. It must be synchronous. A throw or invalid return falls back to `"default"` and warns once. It can't undo a Tier 1 detection, override `onOversize`, or block when `blockHighRisk` is false.

**Caller context.** Give the reviewer the user's task and tool description per call:

```typescript
await defense.defendToolResult(toolOutput, 'gmail_get_message', {
  context: { userGoal: 'Summarize my unread mail', toolDescription: 'Returns one email' },
  signal,                                        // optional: cancels in-flight Tier 3 calls
});
```

#### Choosing the operating point (`blockThreshold`)

By default, Defender uses the provider's `decision` label. The label alone does not define a calibrated probability threshold.

Set `tier3.blockThreshold` to decide on `verdict.score` (P(block)) instead. Raise the threshold to require a higher score to block, or lower it to block at a lower score. Evaluate the trade-off on representative tool results.

This needs a provider that reports `score` as a real P(block). A model's self-reported "confidence" is not one, so `createLlmTier3Provider` only sets `score` when your `complete` returns it. When `score` is missing, the `decision` is used and defender warns once.

#### What you get back

- `result.tier3` is present when Tier 3 ran or was skipped. Use `"tier3" in result` to check.
- With a verdict, `result.tier3` holds `decision`, `score`, `reason` and the other verdict fields. Otherwise it holds `skipReason`, which is short and redacted.
- `errored: true` marks a real failure, not a planned skip.
- `note` (tier3_only) says why the outcome isn't the verdict's alone, for example an oversize block or failed chunks.
- In cascade, `overrideApplied` / `overrideSuppressed` say whether an `allow` undid a Tier 2 block.
- `decidedBy` (`"policy"` or `"options"`) is set when `decide` is configured.
- `allowed` is the final answer. With `allowOverride: false`, `tier3.decision` can be `"allow"` while `allowed` is `false`.
- Defender logs one warning after 20 consecutive provider failures on one instance, which usually means a bad key or model name. Caller cancellations don't count. A separate warning fires after 20 consecutive refusals or unusable replies, which usually means the model doesn't follow the JSON format or runs out of `maxTokens`. Use `onEvent` for proper alerting.
- `maxConcurrency` counts a call until the provider really finishes, even after a timeout, so a slow provider can't exceed it. A call that never finishes gives its slot back after 10 × `timeoutMs`. Waiting for a slot is limited to 10 × `timeoutMs` too, so a deep queue of healthy calls doesn't fail, and a hung provider can't stall callers forever. When the queue is overloaded, `onError` decides: use `"block"` to fail closed. Set `timeoutMs` whenever you set `maxConcurrency`: without it, a call that never settles holds its slot forever (defender warns about this).

**Data handling:** Tier 3 sends tool output to the endpoint you configure. `skipReason` and event `errorCode` carry provider error text after best-effort redaction, so a custom `complete` should throw short, fixed messages. Don't log `reason` or `raw` where tool content mustn't go, and don't show them to the agent; set `includeRaw: false` if needed.
