/**
 * @stackone/injection-guard
 *
 * Prompt injection defense framework for AI tool-calling
 *
 * @example
 * ```typescript
 * import { createPromptDefense } from '@stackone/injection-guard';
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

// Types
export type { RiskLevel, Tier1Result } from './types';

// Pre-bundled Tier 2 weights
export { MLP_WEIGHTS } from './classifiers/weights';

// Core API
export {
  PromptDefense,
  createPromptDefense,
  type PromptDefenseOptions,
  type DefenseResult,
} from './core/prompt-defense';
