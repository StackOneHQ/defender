/**
 * ONNX classifier for fine-tuned MiniLM prompt injection detection.
 *
 * Pipeline: text -> AutoTokenizer -> ONNX Runtime (fine-tuned MiniLM + head) -> logit -> sigmoid -> score
 *
 * Uses @huggingface/transformers AutoTokenizer for tokenization and
 * onnxruntime-node for ONNX model inference. This avoids the pipeline()
 * API which assumes standard HuggingFace output format (our model outputs
 * a single logit, not class probabilities).
 */

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

/**
 * Default path to the bundled ONNX model directory (relative to dist/)
 */
function getDefaultModelPath(): string {
    // Works for both CJS (__dirname) and ESM (import.meta.url)
    let baseDir: string;
    try {
        // ESM
        baseDir = dirname(fileURLToPath(import.meta.url));
    } catch {
        // CJS fallback
        baseDir = __dirname;
    }
    return resolve(baseDir, 'models', 'minilm-full-aug');
}

/**
 * Sigmoid activation function
 */
function sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-x));
}

/**
 * Minimal tokenizer interface (subset of @huggingface/transformers PreTrainedTokenizer)
 */
interface Tokenizer {
    (
        text: string | string[],
        options?: {
            padding?: boolean | string;
            truncation?: boolean;
            max_length?: number;
            return_tensor?: boolean;
        },
    ): {
        input_ids: bigint[][] | { tolist: () => bigint[][] };
        attention_mask: bigint[][] | { tolist: () => bigint[][] };
    };
}

/**
 * Minimal ONNX Runtime InferenceSession interface
 */
interface OrtInferenceSession {
    run(
        feeds: Record<string, unknown>,
        options?: unknown,
    ): Promise<Record<string, { data: Float32Array | number[]; dims: number[] }>>;
}

/**
 * Minimal ONNX Runtime Tensor constructor interface
 */
interface OrtTensorConstructor {
    new (type: string, data: BigInt64Array, dims: number[]): unknown;
}

/**
 * ONNX Classifier for fine-tuned MiniLM models
 *
 * Usage:
 * ```typescript
 * const classifier = new OnnxClassifier();
 * await classifier.loadModel();  // loads from bundled path
 * await classifier.warmup();
 *
 * const score = await classifier.classify("Ignore previous instructions");
 * console.log(score); // 0.95 (high = likely injection)
 * ```
 */
export class OnnxClassifier {
    private session: OrtInferenceSession | null = null;
    private tokenizer: Tokenizer | null = null;
    private OrtTensor: OrtTensorConstructor | null = null;
    private modelPath: string;
    private loadingPromise: Promise<void> | null = null;
    private maxLength = 256;

    constructor(modelPath?: string) {
        this.modelPath = modelPath ?? getDefaultModelPath();
    }

    /**
     * Load the ONNX model and tokenizer.
     *
     * @param modelPath - Optional override for the model directory path
     */
    async loadModel(modelPath?: string): Promise<void> {
        if (modelPath) {
            this.modelPath = modelPath;
        }

        if (this.session && this.tokenizer) {
            return;
        }

        if (this.loadingPromise) {
            return this.loadingPromise;
        }

        this.loadingPromise = this._loadModel();
        try {
            await this.loadingPromise;
        } catch (error) {
            this.loadingPromise = null;
            throw error;
        }
    }

    private async _loadModel(): Promise<void> {
        // Dynamic imports — these are optional peer dependencies
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const transformers = (await import('@huggingface/transformers')) as unknown as {
            AutoTokenizer: {
                from_pretrained: (
                    path: string,
                    options?: { local_files_only: boolean },
                ) => Promise<Tokenizer>;
            };
        };

        this.tokenizer = await transformers.AutoTokenizer.from_pretrained(this.modelPath, {
            local_files_only: true,
        });

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const ort = (await import('onnxruntime-node')) as unknown as {
            InferenceSession: {
                create: (path: string) => Promise<OrtInferenceSession>;
            };
            Tensor: OrtTensorConstructor;
        };

        this.OrtTensor = ort.Tensor;
        const onnxPath = resolve(this.modelPath, 'model_quantized.onnx');
        this.session = await ort.InferenceSession.create(onnxPath);
    }

    /**
     * Classify a single text, returning a sigmoid score in [0, 1].
     * Higher values indicate higher probability of prompt injection.
     *
     * @param text - Text to classify
     * @returns Sigmoid score in [0, 1]
     */
    async classify(text: string): Promise<number> {
        await this.ensureLoaded();

        const { inputIds, attentionMask } = this.tokenize(text);

        if (!this.OrtTensor) {
            throw new Error('OrtTensor not loaded');
        }

        const inputIdsTensor = new this.OrtTensor('int64', inputIds, [1, inputIds.length]);
        const attentionMaskTensor = new this.OrtTensor('int64', attentionMask, [
            1,
            attentionMask.length,
        ]);

        const results = await this.session?.run({
            input_ids: inputIdsTensor,
            attention_mask: attentionMaskTensor,
        });

        const logit = results?.['logits']?.data[0];
        if (logit === undefined || logit === null) {
            throw new Error('ONNX model returned no logits');
        }

        return sigmoid(Number(logit));
    }

    /**
     * Classify multiple texts in batch.
     *
     * @param texts - Array of texts to classify
     * @returns Array of sigmoid scores in [0, 1]
     */
    async classifyBatch(texts: string[]): Promise<number[]> {
        if (texts.length === 0) return [];

        await this.ensureLoaded();

        // Tokenize all texts, padding to the same length
        const tokenized = texts.map((t) => this.tokenize(t));
        const maxLen = Math.max(...tokenized.map((t) => t.inputIds.length));

        // Pad to max length and concatenate into batch tensors
        const batchSize = texts.length;
        const batchInputIds = new BigInt64Array(batchSize * maxLen);
        const batchAttentionMask = new BigInt64Array(batchSize * maxLen);

        for (let i = 0; i < batchSize; i++) {
            const t = tokenized[i];
            if (!t) continue;
            for (let j = 0; j < t.inputIds.length; j++) {
                batchInputIds[i * maxLen + j] = t.inputIds[j] ?? 0n;
                batchAttentionMask[i * maxLen + j] = t.attentionMask[j] ?? 0n;
            }
            // Remaining positions are already 0n (padding)
        }

        if (!this.OrtTensor) {
            throw new Error('OrtTensor not loaded');
        }

        const inputIdsTensor = new this.OrtTensor('int64', batchInputIds, [batchSize, maxLen]);
        const attentionMaskTensor = new this.OrtTensor('int64', batchAttentionMask, [
            batchSize,
            maxLen,
        ]);

        const results = await this.session?.run({
            input_ids: inputIdsTensor,
            attention_mask: attentionMaskTensor,
        });

        const logits = results?.['logits']?.data;
        if (!logits) {
            throw new Error('ONNX model returned no logits');
        }

        const scores: number[] = [];
        for (let i = 0; i < batchSize; i++) {
            scores.push(sigmoid(Number(logits[i])));
        }

        return scores;
    }

    /**
     * Pre-load the model. Call at startup to avoid first-call latency.
     */
    async warmup(): Promise<void> {
        await this.loadModel();
    }

    /**
     * Check if the model is loaded and ready for inference.
     */
    isLoaded(): boolean {
        return this.session !== null && this.tokenizer !== null;
    }

    /**
     * Tokenize a single text into BigInt64Arrays for ONNX Runtime.
     */
    private tokenize(text: string): {
        inputIds: BigInt64Array;
        attentionMask: BigInt64Array;
    } {
        if (!this.tokenizer) {
            throw new Error('Tokenizer not loaded. Call loadModel() first.');
        }

        const encoded = this.tokenizer(text, {
            padding: false,
            truncation: true,
            max_length: this.maxLength,
            return_tensor: false,
        });

        // AutoTokenizer may return Tensor-like objects or plain arrays
        const rawIds: bigint[] = Array.isArray(encoded.input_ids)
            ? (encoded.input_ids as bigint[][]).flat()
            : (encoded.input_ids as { tolist: () => bigint[][] }).tolist().flat();

        const rawMask: bigint[] = Array.isArray(encoded.attention_mask)
            ? (encoded.attention_mask as bigint[][]).flat()
            : (encoded.attention_mask as { tolist: () => bigint[][] }).tolist().flat();

        // Convert to BigInt64Array (onnxruntime-node expects int64)
        const inputIds = new BigInt64Array(rawIds.map((v) => BigInt(v)));
        const attentionMask = new BigInt64Array(rawMask.map((v) => BigInt(v)));

        return { inputIds, attentionMask };
    }

    /**
     * Ensure the model is loaded, loading it if necessary.
     */
    private async ensureLoaded(): Promise<void> {
        if (!this.session || !this.tokenizer) {
            await this.loadModel();
        }
    }
}
