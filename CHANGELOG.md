# Changelog

## [0.3.1](https://github.com/StackOneHQ/connect/compare/defender-v0.3.0...defender-v0.3.1) (2026-02-19)


### Bug Fixes

* **ENG-12119:** release v0.3.1 - add SSPL-1.0 LICENSE and update docs ([#767](https://github.com/StackOneHQ/connect/issues/767)) ([d250563](https://github.com/StackOneHQ/connect/commit/d250563fff5ab013bbd5dad1388511d733cd728c))

## [0.3.0](https://github.com/StackOneHQ/connect/compare/defender-v0.2.0...defender-v0.3.0) (2026-02-19)


### Features

* **ENG-12119:** add @stackone/defender package   ([#747](https://github.com/StackOneHQ/connect/issues/747)) ([55f4ffb](https://github.com/StackOneHQ/connect/commit/55f4ffbda979946a0270309b6ccea75228d70bf3))


### Bug Fixes

* **ENG-11940:** update core dependency ([#702](https://github.com/StackOneHQ/connect/issues/702)) ([abbc31c](https://github.com/StackOneHQ/connect/commit/abbc31c29c3c4cb9c1daf9c8c3cd5807df2d189e))

## 0.2.0

### Added

- **ONNX-based Tier 2 classifier.** Fine-tuned MiniLM-L6-v2 model exported to ONNX with int8 quantization (~22MB), bundled in the package. Now the default Tier 2 mode (`mode: 'onnx'`). Significantly more accurate than the previous MLP approach — 2-bench avg F1 0.876 vs 0.70.
- **`defendToolResults()` batch method.** Defends multiple tool results concurrently via `Promise.all`.
- **`fieldsSanitized` and `patternsByField` in `DefenseResult`.** Provides per-field observability into which fields triggered sanitization and which patterns were found in each.
- **Tier 2 lazy loading.** ONNX model auto-loads on first `defendToolResult()` call if `warmupTier2()` wasn't called explicitly. `warmupTier2()` is still recommended to avoid first-call latency.

### Changed

- **`defendToolResult()` is now the primary API.** Single method that runs Tier 1 pattern detection + Tier 2 ML classification and returns a unified `DefenseResult`.
- **Default Tier 2 mode switched from `'mlp'` to `'onnx'`.** Existing MLP mode is still available via `tier2Config: { mode: 'mlp' }`.
- **Public API surface reduced from ~116 to 8 exports.** Cleaner API: `PromptDefense`, `createPromptDefense`, `PromptDefenseOptions`, `DefenseResult`, `RiskLevel`, `Tier1Result`, `MLP_WEIGHTS`.
- **`onnxruntime-node` added as optional peer dependency** (alongside existing `@huggingface/transformers`).

### Removed

- 7 redundant public methods and 2 standalone functions consolidated into `defendToolResult()`.
- ~108 internal type/constant exports removed from the public API surface.

## 0.1.0

Initial release with Tier 1 pattern detection and Tier 2 MLP classifier.
