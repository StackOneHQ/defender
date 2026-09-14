# ATR-only baseline (Garak + PINT)

A reproducible, ATR-only baseline on Garak (adversarial recall) and a PINT-format
set (precision / recall / F1), contributed per the discussion in
[issue #66](https://github.com/StackOneHQ/defender/issues/66) as a reference
point before deciding whether to bundle ATR rules into Defender.

Defender-side numbers on the same corpora are intentionally left blank for the
Defender team to fill in — this file is the ATR half of a like-for-like table.

## What was measured

- **Engine**: [`agent-threat-rules`](https://github.com/Agent-Threat-Rule/agent-threat-rules)
  v4.0.0, 784 rules loaded (only a minority fire on these corpora), commit
  [`464548b4`](https://github.com/Agent-Threat-Rule/agent-threat-rules/commit/464548b4).
  Numbers below are pinned to that commit; re-run the scripts against a newer
  commit for a current figure — the ruleset grows over time, so compare against
  this pinned commit rather than mixing versions.
- **Garak**: the public in-the-wild jailbreak corpus plus a family sweep
  (3,475 samples across 23 families). Two families are out of ATR's agent-attack
  scope and excluded from the headline recall: `snowball` (1,500 reasoning-error
  probes) and `harmbench` (200 raw harmful-intent completions). In-scope = 1,775
  samples across 21 families.
- **PINT-format**: a self-built 850-sample corpus (451 attack / 399 benign) in
  the format Lakera's PINT benchmark uses, assembled from
  `deepset/prompt-injections` (660) and `Lakera/gandalf_ignore_instructions`
  (190). It is **not** a run of Lakera's PINT benchmark, which is private and
  roughly five times larger. Its value here is being the only corpus in this
  document with a real, measured precision number rather than `precision = 1` by
  construction on an all-adversarial set.

## Reproduce

```bash
git clone https://github.com/Agent-Threat-Rule/agent-threat-rules
cd agent-threat-rules && git checkout v4.0.0   # 464548b4
npm ci && npm run build
npx tsx scripts/run-garak-full-benchmark.ts   # -> data/garak-benchmark/garak-full-report.json
npx tsx src/eval/run-pint-benchmark.ts        # -> data/pint-benchmark/pint-eval-report.json
```

The eval harness is not shipped in the published npm package (`dist` / `spec` /
`rules` only), so reproducing requires the repo checkout above rather than
`npm install agent-threat-rules`.

## Results (ATR-only, v4.0.0)

### Garak — recall

| Scope | Recall |
| :-- | :-- |
| In-scope (21 families, 1,775 samples) | **80.5%** (1,429 / 1,775) |
| Overall (all 23 families, 3,475 samples) | 57.2% (1,987 / 3,475) — dragged down by the two out-of-scope families above |

Strongest in-scope families: `autodan` 100% (4/4), `sysprompt_extraction` 96.4%
(27/28), `dan` 92.5% (614/664), `inthewild` 92.3% (600/650), `gcg` 92.3%
(12/13). Weakest in-scope: `packagehallucination` 13.3% (6/45), `dra` 16.0%
(13/81), `latentinjection` 34.4% (22/64).

### PINT-format — precision / recall / F1

| Metric | Value |
| :-- | :-- |
| Precision | 100% |
| Recall | 65.4% |
| F1 | 79.1% |
| Confusion | TP=295, FP=0, TN=399, FN=156 |

## Reading the numbers honestly

- Garak measures **recall** on adversarial-only corpora, so it says nothing
  about false positives; PINT is the only line here with a real precision number
  because it carries benign samples.
- The overall-Garak 57.2% is **not** a like-for-like figure — it includes two
  families outside ATR's scope by design. The in-scope 80.5% is the number to
  compare against a detector run on the same 21 families.
- The PINT-format corpus is **not** Lakera's PINT (see above) — a reader seeing
  "PINT" should not assume the official benchmark.
- The PINT 100% precision is **in-sample**: eight rules reference this corpus —
  five were mined from its false negatives, and two record zero-false-positive
  verification against its benign half. The benign set the precision is measured
  on is one the rules were verified against.
- The PINT column is **concentrated**: one rule (`ATR-2026-00001`) accounts for
  226 of 295 true positives (76.6%).
- The two rows are **measured at different widths** and are not directly
  comparable: the PINT row runs through the eval-harness canonical shape set
  (which includes an admit-all shape plus a skill scan), the Garak row through
  two production channels only. Read each on its own terms.
- The Tier-2.5 embedding stage runs on the PINT cell but changes no cell of the
  matrix (identical with it disabled), so the PINT result stands as a pure-regex
  number.
- These corpora are **jailbreak-shaped, not tool-result traffic** — the decision
  on a bundled Tier-1 pack should be driven by a tool-result benign FP check,
  not these. The per-family breakdown above shows which ATR families are the
  strongest candidates for such a pack.
