# ATR vs Defender baseline (Garak + PINT)

A reproducible baseline on Garak (adversarial recall) and the Lakera PINT set
(precision / recall / F1), following the discussion in
[issue #66](https://github.com/StackOneHQ/defender/issues/66) and
[PR #75](https://github.com/StackOneHQ/defender/pull/75).

ATR-only numbers were contributed by [@eeee2345](https://github.com/eeee2345).
Defender columns were filled locally against the **same corpora** with
`@stackone/defender` (`blockHighRisk: true` → positive when `allowed === false`).

## What was measured

- **ATR**: [`agent-threat-rules`](https://github.com/Agent-Threat-Rule/agent-threat-rules)
  v3.5.7, 714 rules, commit [`1831d0d5`](https://github.com/Agent-Threat-Rule/agent-threat-rules/commit/1831d0d5) on `main`.
  Numbers below are pinned to that commit; rerun the scripts against a newer
  commit for a current figure — the ruleset grows over time.
- **Defender**: local `@stackone/defender` (post-0.7.2 workspace build).
  - **Tier 1**: `enableTier1: true`, `enableTier2: false`
  - **Tier 1+2**: `enableTier1: true`, `enableTier2: true` (default cascade)
- **Garak**: the public in-the-wild jailbreak corpus plus a 23-family sweep
  (3,475 samples). Two families are excluded from the headline recall number:
  `snowball` (1,500 reasoning-error probes, not agent-attack payloads) and
  `harmbench` (200 raw harmful-intent completions, out of ATR's agent-attack
  scope). In-scope = 1,775 samples across 21 families.
- **PINT**: Lakera's public Prompt Injection Test set (850 samples: 451 attack /
  399 benign) — the only corpus here with a real, measured precision number
  (not `precision = 1` by construction, as on an all-adversarial set).

## Reproduce

### ATR

```bash
git clone https://github.com/Agent-Threat-Rule/agent-threat-rules
cd agent-threat-rules && git checkout 1831d0d5
npm ci && npm run build
npx tsx scripts/run-garak-full-benchmark.ts   # -> data/garak-benchmark/garak-full-report.json
npx tsx src/eval/run-pint-benchmark.ts        # -> data/pint-benchmark/pint-eval-report.json
```

The ATR eval harness is not shipped in the published npm package (`dist` /
`spec` / `rules` only), so reproducing requires the repo checkout above rather
than `npm install agent-threat-rules`.

### Defender

Use the same corpus JSON under the ATR checkout (`data/test-corpora/garak-full/`,
`data/pint-benchmark/pint-corpus.json`) and call `createPromptDefense` +
`defendToolResult` with `blockHighRisk: true`. Count a positive when
`result.allowed === false`. Run once with `enableTier2: false` (Tier 1) and
once with Tier 2 enabled (Tier 1+2).

## Results

### Garak — recall

| Engine | In-scope (21 families, 1,775) | Overall (23 families, 3,475) |
| :-- | :-- | :-- |
| **ATR** | **74.4%** (1,321 / 1,775) | 38.2% (1,329 / 3,475) |
| **Defender Tier 1** | 33.5% (595 / 1,775) | 17.1% (595 / 3,475) |
| **Defender Tier 1+2** | **76.8%** (1,363 / 1,775) | 41.7% (1,448 / 3,475) |

ATR strongest families (reported in #75): `autodan` 100%, `sysprompt_extraction`
100%, `dan` 87.7%, `inthewild` 87.5%, `agent_breaker` 85.7%. Weakest in-scope:
`latentinjection` 34.4%; `badchars` / `malwaregen` / `sata` / `smuggling` ~12.5%
each (small families, 16 samples each).

### PINT — precision / recall / F1

| Engine | Precision | Recall | F1 | Confusion |
| :-- | :-- | :-- | :-- | :-- |
| **ATR** | **99.7%** | 63.6% | 77.7% | TP=287, FP=1, TN=398, FN=164 |
| **Defender Tier 1** | **100%** | 12.9% | 22.8% | TP=58, FP=0, TN=399, FN=393 |
| **Defender Tier 1+2** | 82.1% | **87.6%** | **84.8%** | TP=395, FP=86, TN=313, FN=56 |

ATR's single false positive is a documented known case (`pint-0121`). Defender
Tier 1+2 false positives on this set are concentrated on benign (often
non-English) chat-style prompts — distribution shift vs tool-result traffic.

## Reading the numbers honestly

- Garak measures **recall** on adversarial-only corpora, so it says nothing
  about false positives; PINT is the only line here with a real precision
  number because it carries benign samples.
- The overall-Garak figures include two families outside ATR's stated scope;
  **in-scope recall** is the number to compare across engines.
- Report **both** Defender Tier 1 and Tier 1+2 — a single “Defender” cell is
  misleading. Tier 1 is a small curated regex pack (~57 patterns); Tier 2
  carries most recall on these chat/jailbreak sets.
- ATR leads on **PINT precision**; Defender Tier 1+2 leads on **PINT recall/F1**
  and is roughly tied with ATR on **Garak in-scope recall**.
- These corpora are jailbreak/PINT-shaped, not tool-result payloads. An FP
  check on tool-like benign data (emails, API JSON, documents) is still needed
  before deciding on an opt-in ATR pack (see surface-fit discussion in #66).
