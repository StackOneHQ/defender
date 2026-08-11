# ATR-only baseline (Garak + PINT)

A reproducible, ATR-only baseline on Garak (adversarial recall) and the Lakera
PINT set (precision / recall / F1), contributed per the discussion in
[issue #66](https://github.com/StackOneHQ/defender/issues/66) as a reference
point before deciding whether to bundle ATR rules into Defender.

Defender-side numbers on the same corpora are intentionally left blank for the
Defender team to fill in — this file is the ATR half of a like-for-like table.

## What was measured

- **Engine**: [`agent-threat-rules`](https://github.com/Agent-Threat-Rule/agent-threat-rules)
  v3.5.7, 714 rules, commit [`1831d0d5`](https://github.com/Agent-Threat-Rule/agent-threat-rules/commit/1831d0d5) on `main`.

  Every figure below is that commit, not the current release. The upstream
  benchmark table moves — on 3.5.11 the all-families garak number is
  materially higher than the 38.2% recorded here — so compare against this
  pinned commit or re-run both engines on the same newer one, but do not mix
  the two.
  Numbers below are pinned to that commit; rerun the scripts against a newer
  commit for a current figure — the ruleset grows over time.
- **Garak**: the public in-the-wild jailbreak corpus plus a 23-family sweep
  (3,475 samples). Two families are excluded from the headline recall number:
  `snowball` (1,500 reasoning-error probes, not agent-attack payloads) and
  `harmbench` (200 raw harmful-intent completions, out of ATR's agent-attack
  scope). In-scope = 1,775 samples across 21 families.
- **PINT-format**: a self-built 850-sample corpus (451 attack / 399 benign) in
  the format Lakera's PINT benchmark uses, assembled from
  `deepset/prompt-injections` and `Lakera/gandalf_ignore_instructions`. It is
  **not** a run of Lakera's PINT benchmark, which is private and roughly five
  times larger. Its value here is that it is the only corpus in this document
  with a real, measured precision number rather than `precision = 1` by
  construction on an all-adversarial set. Read it as a prompt-injection-family
  score: only a minority of the ruleset fires on it at all, and one rule
  accounts for most of the detections.

## Reproduce

```bash
git clone https://github.com/Agent-Threat-Rule/agent-threat-rules
cd agent-threat-rules && git checkout 1831d0d5
npm ci && npm run build
npx tsx scripts/run-garak-full-benchmark.ts   # -> data/garak-benchmark/garak-full-report.json
npx tsx src/eval/run-pint-benchmark.ts        # -> data/pint-benchmark/pint-eval-report.json
```

The eval harness is not shipped in the published npm package (`dist` / `spec` /
`rules` only), so reproducing requires the repo checkout above rather than
`npm install agent-threat-rules`.

## Results (ATR-only)

### Garak — recall

| Scope | Recall |
| :-- | :-- |
| In-scope (21 families, 1,775 samples) | **74.4%** (1,321 / 1,775) |
| Overall (all 23 families, 3,475 samples) | 38.2% (1,329 / 3,475) — dragged down by the two out-of-scope families above |

Strongest families: `autodan` 100%, `sysprompt_extraction` 100%, `dan` 87.7%,
`inthewild` 87.5%, `agent_breaker` 85.7%. Weakest in-scope: `latentinjection`
34.4%; `badchars` / `malwaregen` / `sata` / `smuggling` ~12.5% each (small
families, 16 samples each).

### PINT — precision / recall / F1

| Metric | Value |
| :-- | :-- |
| Precision | 99.7% |
| Recall | 63.6% |
| F1 | 77.7% |
| Confusion | TP=287, FP=1, TN=398, FN=164 |

The single false positive is a documented, known case (`pint-0121`) tracked
against the rule that fires on it.

## Reading the numbers honestly

- Garak measures **recall** on adversarial-only corpora, so it says nothing
  about false positives; PINT is the only line here with a real precision
  number because it carries benign samples.
- The overall-Garak 38.2% is not a like-for-like figure — it includes two
  families outside ATR's scope by design. The in-scope 74.4% is the number to
  compare against a detector run on the same 21 families.
- If a tool-result-focused subset is the right starting point for a bundled
  pack (per the Tier-1 surface-fit point in #66), the per-family breakdown
  above shows which ATR families are already strong candidates.
