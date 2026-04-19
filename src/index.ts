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

// Core API
export {
	createPromptDefense,
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
export type { RiskLevel, Tier1Result } from "./types";
