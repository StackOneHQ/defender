# Parked notes (TEMP — delete after actioning)

Two items surfaced during the config-surface handoff review, parked here so they don't get lost. Both concern the **TS** `@stackone/defender` repo.

## 1. Pin PR #73 + config redesign into 0.8.x (not 1.0.0)

`release-please-config.json` is bare:
```json
{ "packages": { ".": {} } }
```
At 0.7.2, release-please's default treats a breaking change as **1.0.0**. PR #73 (detect-and-gate) is breaking, so it will propose 1.0.0 as-is. To land it (and the config-surface redesign) as **0.8.0**, add:
```json
{ "packages": { ".": { "bump-minor-pre-major": true } } }
```
Makes breaking → minor and `feat` → minor while under 1.0.

## 2. `tier2UnavailableWarned` is instance-scoped but instances are per-request

PR #73 added `tier2UnavailableWarned` as an **instance** field (`src/core/prompt-defense.ts:356`, used ~:502) with a docstring claiming "warns once per instance." Production constructs a fresh `PromptDefense` per request (`connect-sdk` `runAction.ts:655`), so a missing ONNX peer dep would log at **full request volume** — the exact defect class already noted for `tier3MissingProviderWarned` / `tier3MissingScoreWarned`. Fix: make the warn flag **module-scoped** (or lead with TSDoc `@deprecated` + module-scoped runtime signal). Cheaper to fix before #73 merges than as a follow-up.

## 3. ENG-1536 #7 (chunk cap) — DEFERRED as unsafe-as-specified

The ticket's #7 "cap total chunks per call" was scoped as: cap unique chunks (post-dedupe) at ~2000, first-N deterministic, dropped chunks fail-open (unscored → 0). Adversarial review found this is a **critical Tier 2 bypass**:

- Extraction order is deterministic and attacker-influenceable (they control the returned SaaS data → sort by name/date/id). Flood ≥2000 unique benign fields that sort ahead, put the injection at field 2001 → it's a dropped unique chunk → scored 0 → `allowed: true`. 100% reliable.
- Fail-open contradicts detect-and-gate; `droppedChunks` is telemetry, the decision reads clean.

Latency justification is also weak: buckets (#1) + dedupe (#3) already removed the dominant cost, and the residual pathological case is narrow. Measured: on 3000 unique fields, inference dominates (inferMs ~1387 vs prepareMs ~3), so a cap *could* help latency — but not enough to justify the hole.

**If ever revisited:** overflow must *degrade, not drop* — set `coverageDegraded: true`, fail-closed / elevate / force Tier 3 for `blockHighRisk` callers, sample stratified across the whole payload (never a prefix). Not worth it until telemetry shows real payloads exceeding a safe cap.

## 4. Density-damping flooding evasion (pre-existing, NOT part of #1-#3) — needs own ticket

`prompt-defense.ts:987`: single-head block decision uses `tier2EffectiveScore = tier2Score * (highCount/perStringScores.length)**0.1`. Intent: cut FPR on benign lists where one field reads imperative. Side effect: an attacker who controls payload composition pads with benign fields to drive the ratio → factor down, suppressing a real injection below the 0.4 threshold.

Repro (confirmed end-to-end on minilm-multihead-v5, single-head path): a 0.972-scoring injection + benign padding → `allowed` flips at just **~100 benign fields** (effective 0.613, medium), and keeps dropping (1000→0.487, 9999→0.387) — while raw `tier2RawScore` stays 0.973 throughout. So even a near-max-confidence detection is evaded with a normal-sized benign list. Only very-high raw scores near 1.0 survive; multi-head configs use the rule path and are unaffected.

Root tension: the damping can't distinguish "benign list + one imperative field" (the FP it targets) from "injection + benign padding" (the evasion) — identical shape. Fix options: raise the factor floor, exempt raw scores above an absolute ceiling from damping, or require the raw max to clear a hard bar regardless of density. Detection-quality bug — do NOT fold into the ENG-1536 latency PR.

## Sequencing note

Handoff says "merge #74 first, then 0.8.0" but ignores #73, which is larger and touches the same constructor region (incl. `defaultRiskLevel ?? "medium"` → `"low"` at ~:371, between the lines #74 edits). Recommended order: **#74 → rebase #73 → config redesign**.
