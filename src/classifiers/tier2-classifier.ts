/**
 * Tier 2 Classifier: MLP-based prompt injection detection
 *
 * Pipeline: text -> embedding (Xenova/MiniLM) -> MLP -> probability score
 *
 * This classifier is designed for higher accuracy at the cost of:
 * - Higher latency (~10-50ms vs ~1ms for Tier 1)
 * - Dependency on @huggingface/transformers
 * - Model download on first use (~100MB)
 */

import type { Tier2Result } from '../types';
import { Embedder, createEmbedder, type EmbedderConfig } from './embedder';
import { loadMLPWeights, mlpForward, type MLPModel, type MLPWeights } from './mlp';

/**
 * Tier 2 classifier configuration
 */
export interface Tier2ClassifierConfig {
  /** Score threshold for high risk (default: 0.8) */
  highRiskThreshold: number;
  /** Score threshold for medium risk (default: 0.5) */
  mediumRiskThreshold: number;
  /** Minimum text length to classify (shorter texts are skipped) */
  minTextLength: number;
  /** Maximum text length to classify (longer texts are truncated) */
  maxTextLength: number;
  /** Embedder configuration */
  embedder?: Partial<EmbedderConfig>;
}

/**
 * Default Tier 2 configuration
 */
export const DEFAULT_TIER2_CLASSIFIER_CONFIG: Tier2ClassifierConfig = {
  highRiskThreshold: 0.8,
  mediumRiskThreshold: 0.5,
  minTextLength: 10,
  maxTextLength: 10000,
};

/**
 * Tier 2 Classifier using MLP + embeddings
 *
 * Usage:
 * ```typescript
 * const classifier = new Tier2Classifier();
 * await classifier.loadWeights(weightsJson);
 * await classifier.warmup(); // Optional: pre-load embedding model
 *
 * const result = await classifier.classify("Ignore previous instructions");
 * console.log(result.score); // 0.95 (high = likely injection)
 * ```
 */
export class Tier2Classifier {
  private config: Tier2ClassifierConfig;
  private embedder: Embedder;
  private model: MLPModel | null = null;

  constructor(config: Partial<Tier2ClassifierConfig> = {}) {
    this.config = { ...DEFAULT_TIER2_CLASSIFIER_CONFIG, ...config };
    this.embedder = createEmbedder(config.embedder);
  }

  /**
   * Load MLP weights from exported JSON
   *
   * @param weights - Weights exported from export_mlp_weights.py
   */
  loadWeights(weights: MLPWeights): void {
    this.model = loadMLPWeights(weights);
  }

  /**
   * Check if weights are loaded
   */
  isReady(): boolean {
    return this.model !== null;
  }

  /**
   * Check if embedding model is loaded
   */
  isEmbedderLoaded(): boolean {
    return this.embedder.isLoaded();
  }

  /**
   * Pre-load the embedding model
   * Call this at startup to avoid latency on first classify() call
   */
  async warmup(): Promise<void> {
    await this.embedder.warmup();
  }

  /**
   * Classify a single text for prompt injection
   *
   * @param text - Text to classify
   * @returns Tier2Result with score, confidence, and timing
   */
  async classify(text: string): Promise<Tier2Result> {
    const startTime = performance.now();

    // Check if weights are loaded
    if (!this.model) {
      return {
        score: 0,
        confidence: 0,
        skipped: true,
        skipReason: 'MLP weights not loaded',
        latencyMs: performance.now() - startTime,
      };
    }

    // Skip very short texts
    if (text.length < this.config.minTextLength) {
      return {
        score: 0,
        confidence: 0,
        skipped: true,
        skipReason: `Text too short (${text.length} < ${this.config.minTextLength})`,
        latencyMs: performance.now() - startTime,
      };
    }

    // Truncate very long texts
    const analysisText =
      text.length > this.config.maxTextLength
        ? text.slice(0, this.config.maxTextLength)
        : text;

    try {
      // Generate embedding
      const embedding = await this.embedder.embedOne(analysisText);

      // Run MLP forward pass
      const score = mlpForward(this.model, embedding);

      // Calculate confidence based on how far from 0.5 the score is
      // Score of 0 or 1 = high confidence, score of 0.5 = low confidence
      const confidence = Math.abs(score - 0.5) * 2;

      return {
        score,
        confidence,
        skipped: false,
        latencyMs: performance.now() - startTime,
      };
    } catch (error) {
      return {
        score: 0,
        confidence: 0,
        skipped: true,
        skipReason: `Classification error: ${(error as Error).message}`,
        latencyMs: performance.now() - startTime,
      };
    }
  }

  /**
   * Classify multiple texts in batch
   *
   * @param texts - Array of texts to classify
   * @returns Array of Tier2Results
   */
  async classifyBatch(texts: string[]): Promise<Tier2Result[]> {
    // For now, classify sequentially
    // Could be optimized with batch embedding in the future
    const results: Tier2Result[] = [];
    for (const text of texts) {
      results.push(await this.classify(text));
    }
    return results;
  }

  /**
   * Classify text using sentence-level analysis.
   * Splits text into sentences, classifies each, and returns the max score.
   * This helps detect malicious content hidden within larger benign text.
   *
   * @param text - Text to classify
   * @returns Tier2Result with max score across all sentences
   */
  async classifyBySentence(text: string): Promise<Tier2Result & { maxSentence?: string; sentenceScores?: Array<{ sentence: string; score: number }> }> {
    const startTime = performance.now();

    // Check if weights are loaded
    if (!this.model) {
      return {
        score: 0,
        confidence: 0,
        skipped: true,
        skipReason: 'MLP weights not loaded',
        latencyMs: performance.now() - startTime,
      };
    }

    // Split into sentences using multiple delimiters
    const sentences = this.splitIntoSentences(text);

    if (sentences.length === 0) {
      return {
        score: 0,
        confidence: 0,
        skipped: true,
        skipReason: 'No sentences found',
        latencyMs: performance.now() - startTime,
      };
    }

    // Classify each sentence
    const sentenceScores: Array<{ sentence: string; score: number }> = [];
    let maxScore = 0;
    let maxSentence = '';

    for (const sentence of sentences) {
      if (sentence.length < this.config.minTextLength) {
        continue;
      }

      try {
        const embedding = await this.embedder.embedOne(sentence);
        const score = mlpForward(this.model, embedding);

        sentenceScores.push({ sentence, score });

        if (score > maxScore) {
          maxScore = score;
          maxSentence = sentence;
        }
      } catch {
        // Skip sentences that fail to embed
        continue;
      }
    }

    if (sentenceScores.length === 0) {
      return {
        score: 0,
        confidence: 0,
        skipped: true,
        skipReason: 'No classifiable sentences',
        latencyMs: performance.now() - startTime,
      };
    }

    const confidence = Math.abs(maxScore - 0.5) * 2;

    return {
      score: maxScore,
      confidence,
      skipped: false,
      latencyMs: performance.now() - startTime,
      maxSentence,
      sentenceScores,
    };
  }

  /**
   * Split text into sentences for granular analysis.
   * Uses multiple strategies to handle various text formats.
   */
  private splitIntoSentences(text: string): string[] {
    const sentences: string[] = [];

    // Split by common sentence delimiters
    // Include newlines as delimiters since they often separate logical chunks
    const chunks = text.split(/(?<=[.!?])\s+|\n\n+|\n(?=[A-Z0-9#\-*])|(?<=:)\s*\n/);

    for (const chunk of chunks) {
      const trimmed = chunk.trim();
      if (trimmed.length > 0) {
        // Further split long chunks by newlines
        if (trimmed.length > 200 && trimmed.includes('\n')) {
          const subChunks = trimmed.split('\n');
          for (const sub of subChunks) {
            const subTrimmed = sub.trim();
            if (subTrimmed.length > 0) {
              sentences.push(subTrimmed);
            }
          }
        } else {
          sentences.push(trimmed);
        }
      }
    }

    return sentences;
  }

  /**
   * Quick check if text is likely a prompt injection
   *
   * @param text - Text to check
   * @param threshold - Score threshold (default: mediumRiskThreshold)
   * @returns true if score exceeds threshold
   */
  async isInjection(text: string, threshold?: number): Promise<boolean> {
    const result = await this.classify(text);
    if (result.skipped) {
      return false;
    }
    return result.score >= (threshold ?? this.config.mediumRiskThreshold);
  }

  /**
   * Get risk level based on score
   */
  getRiskLevel(score: number): 'low' | 'medium' | 'high' {
    if (score >= this.config.highRiskThreshold) {
      return 'high';
    }
    if (score >= this.config.mediumRiskThreshold) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Get current configuration
   */
  getConfig(): Tier2ClassifierConfig {
    return { ...this.config };
  }

  /**
   * Get the underlying embedder
   */
  getEmbedder(): Embedder {
    return this.embedder;
  }
}

/**
 * Create a Tier 2 classifier instance
 */
export function createTier2Classifier(
  config?: Partial<Tier2ClassifierConfig>
): Tier2Classifier {
  return new Tier2Classifier(config);
}
