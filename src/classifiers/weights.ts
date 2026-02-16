/**
 * Pre-bundled MLP weights for Tier 2 classification.
 *
 * These weights are trained on the Qualifire dataset for prompt injection detection.
 * Model: 384 (embedding dim) -> 256 -> 128 -> 1
 * Embedding model: sentence-transformers/all-MiniLM-L6-v2
 */

import type { MLPWeights } from './mlp';

// Import the weights JSON (resolveJsonModule is enabled in tsconfig)
import mlpWeightsJson from './mlp_weights.json';

/**
 * Pre-bundled MLP weights for prompt injection classification.
 *
 * These weights are automatically loaded from the bundled JSON file.
 * Use with Tier2Classifier.loadWeights() or pass to PromptDefense options.
 *
 * @example
 * ```typescript
 * import { MLP_WEIGHTS, createTier2Classifier } from '@stackone/defender';
 *
 * const classifier = createTier2Classifier();
 * classifier.loadWeights(MLP_WEIGHTS);
 * ```
 */
export const MLP_WEIGHTS: MLPWeights = mlpWeightsJson as MLPWeights;

/**
 * Check if the bundled weights are available and valid.
 */
export function hasValidWeights(): boolean {
  try {
    const w = MLP_WEIGHTS;
    return !!(
      w?.state_dict?.['net.0.weight'] &&
      w?.state_dict?.['net.0.bias'] &&
      w?.state_dict?.['net.3.weight'] &&
      w?.state_dict?.['net.3.bias'] &&
      w?.state_dict?.['net.6.weight'] &&
      w?.state_dict?.['net.6.bias']
    );
  } catch {
    return false;
  }
}
