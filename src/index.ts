/**
 * @stackone/defender
 *
 * Prompt injection defense framework for AI tool-calling
 *
 * @example
 * ```typescript
 * import { createPromptDefense } from '@stackone/defender';
 *
 * const defense = createPromptDefense({ enableTier2: true });
 * await defense.warmupTier2();
 *
 * const result = await defense.defendToolResult(toolOutput, 'gmail_get_message');
 * if (!result.allowed) {
 *   console.log(`Blocked: ${result.riskLevel}`);
 * }
 * ```
 */

// Tier 3 provider registry — consumers register a proprietary provider
// (e.g. a SageMaker-hosted LLM) once at app startup; defender ships only
// the interface and orchestration.
export {
	getDefaultTier3Provider,
	setDefaultTier3Provider,
} from "./classifiers/tier3-orchestrator";
// Core API
export {
	createPromptDefense,
	type DefenderMode,
	type DefenseResult,
	PromptDefense,
	type PromptDefenseOptions,
} from "./core/prompt-defense";
// SFE preprocessor (off by default; opt in via PromptDefenseOptions.useSfe)
export {
	getDefaultPredictor,
	getDefaultSfeModelPath,
	type SfePredictor,
	type SfePreprocessOptions,
	type SfePreprocessResult,
	sfePreprocess,
} from "./sfe/preprocess";
// Types
export type { RiskLevel, Tier1Result, Tier3Provider, Tier3Verdict } from "./types";
// Boundary helpers for consumers that opt into `annotateBoundary`
export { containsBoundaryPatterns, generateBoundaryInstructions } from "./utils/boundary";
