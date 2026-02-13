/**
 * Text embedding using Transformers.js (Xenova/all-MiniLM-L6-v2)
 *
 * This is the same model as Python's sentence-transformers/all-MiniLM-L6-v2,
 * ported to ONNX for JavaScript/TypeScript use.
 *
 * IMPORTANT: normalize must be false to match Python training configuration.
 */

/**
 * Embedder configuration
 */
export interface EmbedderConfig {
  /** Model ID (default: Xenova/all-MiniLM-L6-v2) */
  modelId: string;
  /** Pooling strategy (default: mean) */
  pooling: 'mean' | 'cls' | 'max';
  /** Whether to normalize embeddings (default: false - must match Python training) */
  normalize: boolean;
  /** Device to run on (default: auto) */
  device?: 'cpu' | 'gpu' | 'auto';
}

/**
 * Default embedder configuration
 * CRITICAL: normalize=false must match Python training (normalize_embeddings=False)
 */
export const DEFAULT_EMBEDDER_CONFIG: EmbedderConfig = {
  modelId: 'Xenova/all-MiniLM-L6-v2',
  pooling: 'mean',
  normalize: false,
  device: 'cpu',
};

/**
 * Embedder result
 */
export interface EmbedderResult {
  /** Embedding vectors (384-dim for MiniLM) */
  embeddings: number[][];
  /** Time to generate embeddings in ms */
  latencyMs: number;
}

/**
 * Type for the Transformers.js pipeline function
 * We use dynamic import to make @huggingface/transformers optional
 */
type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean }
) => Promise<{ tolist: () => number[][] } | number[][]>;

/**
 * Text Embedder using Transformers.js
 *
 * Lazily loads the embedding model on first use.
 * The model download (~100MB) is cached locally after first run.
 */
export class Embedder {
  private config: EmbedderConfig;
  private pipeline: FeatureExtractionPipeline | null = null;
  private loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(config: Partial<EmbedderConfig> = {}) {
    this.config = { ...DEFAULT_EMBEDDER_CONFIG, ...config };
  }

  /**
   * Lazy-load the embedding pipeline
   */
  private async loadPipeline(): Promise<FeatureExtractionPipeline> {
    if (this.pipeline) {
      return this.pipeline;
    }

    if (this.loadingPromise) {
      return this.loadingPromise;
    }

    this.loadingPromise = this.initPipeline();
    return this.loadingPromise;
  }

  private async initPipeline(): Promise<FeatureExtractionPipeline> {
    try {
      // Dynamic import to make @huggingface/transformers optional
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformers = await (Function('return import("@huggingface/transformers")')() as Promise<{
        pipeline: (
          task: string,
          model: string,
          options: { pooling: string; normalize: boolean }
        ) => Promise<FeatureExtractionPipeline>;
      }>);

      this.pipeline = await transformers.pipeline(
        'feature-extraction',
        this.config.modelId,
        {
          pooling: this.config.pooling,
          normalize: this.config.normalize,
        }
      );

      return this.pipeline;
    } catch (error) {
      this.loadingPromise = null;
      const errMsg = (error as Error).message || String(error);
      if (
        errMsg.includes('Cannot find module') ||
        errMsg.includes('ERR_MODULE_NOT_FOUND') ||
        errMsg.includes('@huggingface/transformers')
      ) {
        throw new Error(
          'Embedder requires @huggingface/transformers. Install with: npm install @huggingface/transformers'
        );
      }
      throw error;
    }
  }

  /**
   * Check if the embedding model is loaded
   */
  isLoaded(): boolean {
    return this.pipeline !== null;
  }

  /**
   * Pre-load the embedding model
   * Call this at startup to avoid latency on first embed() call
   */
  async warmup(): Promise<void> {
    await this.loadPipeline();
  }

  /**
   * Generate embeddings for one or more texts
   *
   * @param texts - Single text or array of texts to embed
   * @returns Embedding vectors and timing info
   */
  async embed(texts: string | string[]): Promise<EmbedderResult> {
    const startTime = performance.now();

    const pipe = await this.loadPipeline();

    const inputTexts = Array.isArray(texts) ? texts : [texts];

    const output = await pipe(inputTexts, {
      pooling: this.config.pooling,
      normalize: this.config.normalize,
    });

    // Transformers.js returns a Tensor with tolist() method, or a raw array
    const embeddings: number[][] =
      typeof (output as { tolist?: () => number[][] }).tolist === 'function'
        ? (output as { tolist: () => number[][] }).tolist()
        : (output as number[][]);

    return {
      embeddings,
      latencyMs: performance.now() - startTime,
    };
  }

  /**
   * Generate embedding for a single text
   *
   * @param text - Text to embed
   * @returns Single embedding vector (384-dim)
   */
  async embedOne(text: string): Promise<number[]> {
    const result = await this.embed(text);
    const embedding = result.embeddings[0];
    if (!embedding) {
      throw new Error('Failed to generate embedding');
    }
    return embedding;
  }

  /**
   * Get the expected embedding dimension
   */
  getEmbeddingDim(): number {
    // MiniLM-L6-v2 produces 384-dim embeddings
    return 384;
  }

  /**
   * Get current configuration
   */
  getConfig(): EmbedderConfig {
    return { ...this.config };
  }
}

/**
 * Create an embedder instance with optional configuration
 */
export function createEmbedder(config?: Partial<EmbedderConfig>): Embedder {
  return new Embedder(config);
}
