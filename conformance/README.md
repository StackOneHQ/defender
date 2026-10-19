# Conformance fixtures

Shared input → expected-output cases that the TypeScript package (`@stackone/defender`) and the Python package (`stackone-defender`, repo `StackOneHQ/defender-py`) must both pass. They cover the parts that must behave identically in both languages, mostly security-relevant ones:

| File | Area | What it pins |
|---|---|---|
| `tier3-serialize.json` | `tier3-serialize` | How a tool result becomes the exact text of each Tier-3 call in `tier3_only`: `field: value` records, chunking, oversize, coverage |
| `tier3-prompt.json` | `tier3-prompt` | Prompt rendering: the default prompt, delimiting of untrusted text, placeholder filling, template validation |
| `tier3-parse.json` | `tier3-parse` | Strict verdict parsing |
| `tier3-redact.json` | `tier3-redact` | Redaction of provider error text in `skipReason` |
| `tier3-policy.json` | `tier3-policy` | Decisions under the Tier-3 options (`allowOverride`, `onError`, `decide`, `blockThreshold`, `onOversize`, `stopOnFirstBlock`, `includeRaw`) with a scripted judge |

Timing behavior (timeouts, concurrency, slot holding) is not here. It stays in each package's own tests.

## Format

```json
{
	"version": 1,
	"area": "tier3-parse",
	"description": "...",
	"cases": [{ "id": "two-objects", "description": "...", "requiresTier2": false, "input": { ... }, "expect": { ... } }]
}
```

Each area maps to the public API. `specs/conformance.spec.ts` is the reference runner. Per area:

- **`tier3-serialize`**:
  - Call `defendToolResult(input.payload, input.toolName ?? "test_tool")` with `enableTier3`, `defenderMode: "tier3_only"`, `blockHighRisk: true` and `tier3: { provider, ...input.tier3 }`. The provider records every call's text and answers `{ decision: "allow" }`.
  - Expect:
    - `calls`: the texts, ordered by chunk index
    - `chunkSummary`: `tier3ChunkSummary` or `null`
    - `coverageDegraded`: a boolean
    - `skipReason`: `tier3.skipReason` or `null`
  - Lengths are **UTF-16 code units**, as in JavaScript. A Python port must count the same way.
- **`tier3-prompt`**:
  - `buildTier3Messages(input.prompt ?? DEFAULT_TIER3_PROMPT, input.text, input.ctx)`. When `input.prompt` is set, validate it first, as `createLlmTier3Provider` does.
  - Expect `{ messages: [{ role, content }] }`, with the 16-hex id inside every real `<<<NAME id=…>>>` marker replaced by `<ID>`. Expect `{ error: true }` when the template is rejected.
- **`tier3-parse`**: `parseVerdictJson(input.reply)`. Expect `{ decision, reason? }`, or `{ error: true }`.
- **`tier3-redact`**: a `tier3_only` call whose provider throws an error with message `input.message`. Expect `{ skipReason }`.
- **`tier3-policy`**:
  - Build `createPromptDefense` from these input fields:
    - `mode`
    - `blockHighRisk`: default `true`
    - `enableTier1`: default `false`
    - `tier2: { enabled, highRiskThreshold?, mediumRiskThreshold? }`: Tier 2 is off when absent
    - `tier3`: the options as given
    - a provider built from `judge` (absent means no provider)
    - `decide`
  - `judge` is a script: `{ default, rules?: [{ ifContains, then }] }`. A verdict is an object returned as-is. `{ "throw": msg }` throws.
  - `decide` is `"allow" | "block" | "default"`, or `"throw"` for a policy function that throws.
  - Expect:
    - `allowed`, `riskLevel`
    - `tier3`: the set fields among `decision`, `score`, `refused`, `reason`, `errored`, `overrideApplied`, `overrideSuppressed`, `decidedBy`, `skipReason`, plus `hasRaw`
    - `coverageDegraded`
    - `chunkSummary`, when set
  - Cases with `requiresTier2: true` need the bundled Tier-2 model. They force Tier 2's verdict with `highRiskThreshold` 0 (would block) or 1 (would allow) and escalate everything. A runner without the model may skip them, but should say so.

Option names are the TypeScript ones (`maxTextLength`, `onError`, …). The Python runner maps them to its snake_case names.

## Changing behavior

1. Change the code.
2. Run `pnpm conformance:update` to re-record the expected outputs.
3. **Review the JSON diff.** It is the behavior change. Don't accept a diff you didn't mean.

To add a case, add an `input` without an `expect`, then run `pnpm conformance:update` and check the recorded output.

## Python

`defender-py` keeps a pinned copy in `tests/conformance/`, with a `VERSION` file naming the TS tag it matches (e.g. `defender-v0.9.1`). A sync script copies the folder at a tag, and a CI check confirms the copy matches it. Porting a TS release starts with syncing its fixtures; the new cases fail in Python until the port is done.

This folder is not published to npm: the package's `files` allowlist is `dist`, `package.json`, `README.md` and `LICENSE`.
