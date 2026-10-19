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
  - Lengths are **UTF-16 code units**, as in JavaScript, and no cut splits a surrogate pair. A Python port must count the same way.
  - Keys are text. A keyed line makes a payload reviewable even with no string value: `key: <scalar>`, `key: null`, or `key:` for an empty string, object or array. Paths with no object key on them (`[0]: 1`) don't. A keyed line dropped for budget counts as oversize.
  - Lines split on `\r`, `\n`, U+2028, U+2029 and U+0085 only.
  - Object keys follow JavaScript order: integer-like keys first, ascending, then insertion order.
  - Numbers render like JavaScript `String(n)`: `-0` → `0`, `1.0` → `1`, `1e16` → `10000000000000000`, `1e21` → `1e+21`.
- **`tier3-prompt`**:
  - `buildTier3Messages(input.prompt ?? DEFAULT_TIER3_PROMPT, input.text, input.ctx)`. When `input.prompt` is set, validate it first, as `createLlmTier3Provider` does.
  - Expect `{ messages: [{ role, content }] }`, with the 16-hex id inside every real `<<<NAME id=…>>>` marker replaced by `<ID1>`, `<ID2>`… in order of first appearance. That still pins that an open/close pair shares an id and that separate blocks get separate ids. Expect `{ error: true }` when the template is rejected.
  - Ids are random per call, which a fixture can't express. A runner should also render twice and check that no id from the first render appears in the second.
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
    - `tier3`: the set fields among `decision`, `score`, `refused`, `reason`, `errored`, `overrideApplied`, `overrideSuppressed`, `decidedBy`, `skipReason`, `note`, plus `hasRaw`
    - `coverageDegraded`
    - `chunkSummary`, when set
    - `judgeCalls`, when there is a judge: how many chunks the judge was actually called for. This pins `stopOnFirstBlock`.
  - Cases with `requiresTier2: true` need the bundled Tier-2 model. They force Tier 2's verdict with `highRiskThreshold` 0 (would block) or 1 (would allow) and escalate everything. A runner without the model may skip them, but should say so.
  - Tier-2 scores differ slightly between runtimes (around 1e-3). Keep those case texts far from scores of exactly 0 and 1, and don't add a case whose outcome depends on a score near a threshold.

Option names are the TypeScript ones (`maxTextLength`, `onError`, …). The Python runner maps them to its snake_case names.

Runner contract for ports: a rejected template and an unusable verdict reply raise a specific error (`ValueError` in Python). Treating any exception as "rejected" would let a broken port pass the error cases.

## Changing behavior

1. Change the code.
2. Run `pnpm conformance:update` to re-record the expected outputs.
3. **Review the JSON diff.** It is the behavior change. Don't accept a diff you didn't mean.

To add a case, add an `input` without an `expect`, then run `pnpm conformance:update` and check the recorded output.

## Python

`defender-py` keeps a pinned copy in `tests/conformance/`, with a `VERSION` file naming the TS tag or commit it matches (e.g. `defender-v0.9.2`, or a commit SHA until a release tag includes the change). A sync script copies the folder at either ref, and a CI check confirms the copy matches it. Porting a TS release starts with syncing its fixtures; the new cases fail in Python until the port is done.

This folder is not published to npm: the package's `files` allowlist is `dist`, `package.json`, `README.md` and `LICENSE`.
