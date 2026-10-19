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

// Tier 3: build a provider around any LLM, or register a hand-written one once at startup.
export {
	buildTier3Messages,
	createLlmTier3Provider,
	DEFAULT_TIER3_PROMPT,
	type LlmCompletion,
	type LlmCompletionRequest,
	type LlmMessage,
	type LlmTier3ProviderOptions,
	type PromptInput,
	parseVerdictJson,
	TIER3_PROMPT_VERSION,
	type Tier3PromptTemplate,
	VERDICT_JSON_SCHEMA,
} from "./classifiers/tier3-llm-provider";
export {
	createOpenAICompatibleTier3Provider,
	type OpenAICompatibleTier3Options,
} from "./classifiers/tier3-openai-compatible";
export {
	getDefaultTier3Provider,
	setDefaultTier3Provider,
} from "./classifiers/tier3-orchestrator";
// Core API
export {
	createPromptDefense,
	type DefenderMode,
	type DefendToolResultOptions,
	type DefenseResult,
	PromptDefense,
	type PromptDefenseOptions,
	type Tier3ResultMeta,
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
export type {
	RiskLevel,
	Tier1Result,
	Tier3CallerContext,
	Tier3Context,
	Tier3DecisionInput,
	Tier3Event,
	Tier3Provider,
	Tier3Verdict,
} from "./types";
// Boundary helpers for consumers that opt into `annotateBoundary`
export { containsBoundaryPatterns, generateBoundaryInstructions } from "./utils/boundary";
