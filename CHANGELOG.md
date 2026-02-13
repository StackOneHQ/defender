# Changelog

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
