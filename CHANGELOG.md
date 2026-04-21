# Changelog

## [0.6.2](https://github.com/StackOneHQ/defender/compare/defender-v0.6.1...defender-v0.6.2) (2026-04-21)


### Bug Fixes

* **ENG-12702:** strip boundary markers from input before classification ([#55](https://github.com/StackOneHQ/defender/issues/55)) ([0fdd9d4](https://github.com/StackOneHQ/defender/commit/0fdd9d447d932735e4821890e7b0499ca979af22))

## [0.6.1](https://github.com/StackOneHQ/defender/compare/defender-v0.6.0...defender-v0.6.1) (2026-04-21)


### Features

* ** ENG-12684:** v4 ONNX model + cumulative risk fixes + opt-in SFE preprocessor (includes ENG-12671) ([#52](https://github.com/StackOneHQ/defender/issues/52)) ([6fb1ff9](https://github.com/StackOneHQ/defender/commit/6fb1ff91fdc0fbbce33bf3b8987321e0945db861))


### Miscellaneous Chores

* release 0.6.1 ([#54](https://github.com/StackOneHQ/defender/issues/54)) ([3611f4b](https://github.com/StackOneHQ/defender/commit/3611f4b039297ebfe3782cb1320b924b80cdb2b9))

## [0.6.0](https://github.com/StackOneHQ/defender/compare/defender-v0.5.8...defender-v0.6.0) (2026-04-16)


### Features

* **ENG-12658:** sentence density adjustment to reduce email notification FPs ([#50](https://github.com/StackOneHQ/defender/issues/50)) ([b4a272d](https://github.com/StackOneHQ/defender/commit/b4a272d69d949ec7c1c0cc4f010703ad81b283c5))


### Bug Fixes

* **ENG-12643:** prevent prototype pollution during object traversal ([#47](https://github.com/StackOneHQ/defender/issues/47)) ([97f85b7](https://github.com/StackOneHQ/defender/commit/97f85b7512fe33415123aa1f7761ccca8cb39fa4))

## [0.5.8](https://github.com/StackOneHQ/defender/compare/defender-v0.5.7...defender-v0.5.8) (2026-04-08)


### Bug Fixes

* **ENG-12604:** chunk batch classification to bound ONNX memory usage ([#44](https://github.com/StackOneHQ/defender/issues/44)) ([46e6548](https://github.com/StackOneHQ/defender/commit/46e65483d87d1a26d503c345b3fdcc55dc800cc0))

## [0.5.7](https://github.com/StackOneHQ/defender/compare/defender-v0.5.6...defender-v0.5.7) (2026-04-08)


### Bug Fixes

* **ENG-12594:** remove per-tool sanitization rules ([#42](https://github.com/StackOneHQ/defender/issues/42)) ([eb4664b](https://github.com/StackOneHQ/defender/commit/eb4664bf73df26961ac5a9ab524a688be775ca6b))

## [0.5.6](https://github.com/StackOneHQ/defender/compare/defender-v0.5.5...defender-v0.5.6) (2026-04-01)


### Bug Fixes

* **ENG-12540:** prevent unhandled rejection cascade on ONNX load failure ([#37](https://github.com/StackOneHQ/defender/issues/37)) ([52c99e3](https://github.com/StackOneHQ/defender/commit/52c99e329b22af2e96106fb1e1f9950e66855c43))

## [0.5.5](https://github.com/StackOneHQ/defender/compare/defender-v0.5.4...defender-v0.5.5) (2026-03-31)


### Bug Fixes

* **ENG-12518:** fix field filter and batch sentence classification ([#35](https://github.com/StackOneHQ/defender/issues/35)) ([878b542](https://github.com/StackOneHQ/defender/commit/878b542261feab7d32b1a24db73a55521bf1930d))

## [0.5.4](https://github.com/StackOneHQ/defender/compare/defender-v0.5.3...defender-v0.5.4) (2026-03-30)


### Bug Fixes

* **ENG-12506:** cache ONNX session at module level to eliminate per-request ([#33](https://github.com/StackOneHQ/defender/issues/33)) ([bd1c580](https://github.com/StackOneHQ/defender/commit/bd1c5806ac4a55703d081d984ec4566efd4d2a3d))

## [0.5.3](https://github.com/StackOneHQ/defender/compare/defender-v0.5.2...defender-v0.5.3) (2026-03-27)


### Bug Fixes

* **ENG-12470:** update inline docs to match implementation, scope Tier 2 to Tier 1 risky fields by default    ([#30](https://github.com/StackOneHQ/defender/issues/30)) ([c103072](https://github.com/StackOneHQ/defender/commit/c10307242ac214e27cb207a876c729ddea5d4e5f))

## [0.5.2](https://github.com/StackOneHQ/defender/compare/defender-v0.5.1...defender-v0.5.2) (2026-03-26)


### Bug Fixes

* use absolute URLs for README images to fix npm display ([#28](https://github.com/StackOneHQ/defender/issues/28)) ([beeb2ef](https://github.com/StackOneHQ/defender/commit/beeb2ef1e2c1dd0806045846f66a586d2576c804))

## [0.5.1](https://github.com/StackOneHQ/defender/compare/defender-v0.5.0...defender-v0.5.1) (2026-03-25)


### Bug Fixes

* **ENG-12448:** upgrade ML classifier to jbv2 (AgentShield 73.7 → 79.8) ([#25](https://github.com/StackOneHQ/defender/issues/25)) ([3061239](https://github.com/StackOneHQ/defender/commit/30612391690390112fe5da5eb065c7205da43378))

## [0.5.0](https://github.com/StackOneHQ/defender/compare/defender-v0.4.5...defender-v0.5.0) (2026-03-23)


### Features

* **ENG-12396:** upgrade ML classifier to jbv5 (AgentShield 73.7 → 81.1) ([#22](https://github.com/StackOneHQ/defender/issues/22)) ([51f50ce](https://github.com/StackOneHQ/defender/commit/51f50ce8af1859468ffb400bac3212a074cfaa6a))
* **ENG-12397:** remove legacy MLP inference mode ([#23](https://github.com/StackOneHQ/defender/issues/23)) ([556dc38](https://github.com/StackOneHQ/defender/commit/556dc38af0148c5bac0580d6b63c11db7387b5d5))

## [0.4.5](https://github.com/StackOneHQ/defender/compare/defender-v0.4.4...defender-v0.4.5) (2026-03-12)


### Bug Fixes

* downgrade nanoid to 3.3.11 to fix CJS compatibility ([#19](https://github.com/StackOneHQ/defender/issues/19)) ([06c1713](https://github.com/StackOneHQ/defender/commit/06c17136c454e5fbb03258183e5a2568417cacc5))

## [0.4.4](https://github.com/StackOneHQ/defender/compare/defender-v0.4.3...defender-v0.4.4) (2026-03-11)


### Bug Fixes

* **ENG-12332:** export ToolSanitizationRule and add tier2Fields option ([#16](https://github.com/StackOneHQ/defender/issues/16)) ([90bfa68](https://github.com/StackOneHQ/defender/commit/90bfa68a4b7ec99285ecb4889a4ef9caafea9561))

## [0.4.3](https://github.com/StackOneHQ/defender/compare/defender-v0.4.2...defender-v0.4.3) (2026-03-09)


### Bug Fixes

* **ENG-12109:** sync toolRules passthrough fix and test updates from connect ([#13](https://github.com/StackOneHQ/defender/issues/13)) ([f1eb775](https://github.com/StackOneHQ/defender/commit/f1eb77595cf67c8f6ff8c8f768eeb30a1a5e6057))

## [0.4.2](https://github.com/StackOneHQ/defender/compare/defender-v0.4.1...defender-v0.4.2) (2026-03-03)


### Bug Fixes

* **DEF-1:** document useDefaultToolRules and add ATS/CRM tool rules ([53764e6](https://github.com/StackOneHQ/defender/commit/53764e625332b4de02d28875641c478dd487fb68))
* **ENG-12236:** document useDefaultToolRules and add ATS/CRM tool rules ([a563ad3](https://github.com/StackOneHQ/defender/commit/a563ad3fa5875552417310f85b09a77d3151c42f))

## [0.4.1](https://github.com/StackOneHQ/defender/compare/defender-v0.4.0...defender-v0.4.1) (2026-03-03)


### Bug Fixes

* **DEF-1:** fix tsconfig extending missing monorepo base and add biome linter config ([44993ba](https://github.com/StackOneHQ/defender/commit/44993ba2b3d6dcbf30e5f0d8e3e7f582ea67aa4f))
* **DEF-1:** fix tsconfig extending missing monorepo base and add biome linter config ([2469987](https://github.com/StackOneHQ/defender/commit/2469987c0adaa2c653aebb08229463d8e5fc15f3))

## [0.4.0](https://github.com/StackOneHQ/defender/compare/defender-v0.3.1...defender-v0.4.0) (2026-03-03)


### Features

* add biome configuration file and fix code formatting ([219526f](https://github.com/StackOneHQ/defender/commit/219526f13f2a24ac6034550a50c4f497447b56b6))
* initial release of @stackone/injection-guard v0.1.0 ([039db9e](https://github.com/StackOneHQ/defender/commit/039db9eecf8a9125e0efbcfd40af45b12f922ec1))
* v0.2.0 — ONNX-based Tier 2 classifier, API improvements ([bbb204d](https://github.com/StackOneHQ/defender/commit/bbb204d562c5d385149e627baea4f5ae888718cf))

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
