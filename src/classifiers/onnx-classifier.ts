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

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Default path to the bundled ONNX model directory (relative to dist/).
 * Exported so `Tier2Classifier` can read model-specific calibration defaults
 * from the model's `classifier_config.json` at construction time.
 */
export function getDefaultModelPath(): string {
	// Works for both CJS (__dirname) and ESM (import.meta.url)
	let baseDir: string;
	try {
		// ESM
		baseDir = dirname(fileURLToPath(import.meta.url));
	} catch {
		// CJS fallback
		baseDir = __dirname;
	}
	return resolve(baseDir, "models", "minilm-multihead-v5");
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
type Tokenizer = (
	text: string | string[],
	options?: {
		padding?: boolean | string;
		truncation?: boolean;
		max_length?: number;
		return_tensor?: boolean;
	},
) => {
	input_ids: bigint[][] | { tolist: () => bigint[][] };
	attention_mask: bigint[][] | { tolist: () => bigint[][] };
};

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
 * Module-level session cache — shared across all OnnxClassifier instances in this process.
 *
 * Keyed by model path. Populated on first successful _loadModel() call and reused by every
 * subsequent instance. Sharing InferenceSession across concurrent run() calls is safe —
 * ONNX Runtime guarantees thread safety for concurrent Run() from v1.7.0. Sharing the
 * tokenizer is safe — tokenize() is synchronous and never mutates the tokenizer object.
 */
const _sessionCache = new Map<
	string,
	{
		session: OrtInferenceSession;
		OrtTensor: OrtTensorConstructor;
		tokenizer: Tokenizer;
	}
>();

/**
 * Module-level in-flight load promises — prevents duplicate concurrent loads when multiple
 * OnnxClassifier instances target the same modelPath simultaneously (e.g. warmup + first request).
 * Entries are removed after the load resolves or rejects.
 */
const _loadingPromises = new Map<string, Promise<void>>();

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
	/**
	 * Detected on first inference from the logits tensor `dims`:
	 *  - `single` → `[batch]` or `[batch, 1]` — sigmoid path, one score per text
	 *  - `multi`  → `[batch, 2]` — main+aux dual-head; `data` is row-major
	 *               `[main_0, aux_0, main_1, aux_1, ...]`
	 *  - `null`   → not yet known (no inference run)
	 */
	private outputMode: "single" | "multi" | null = null;
	/**
	 * Temperature for post-hoc calibration via temperature scaling. The raw
	 * logit is divided by T before sigmoid: `sigmoid(logit / T)`. T > 1
	 * softens overconfident output. T = 1 is a no-op (raw sigmoid).
	 *
	 * Fit T offline on a held-out labeled set by minimizing NLL. See
	 * https://arxiv.org/abs/1706.04599 for the standard recipe.
	 */
	private temperatureT = 1.0;

	constructor(modelPath?: string, temperatureT?: number) {
		this.modelPath = modelPath ?? getDefaultModelPath();
		if (temperatureT !== undefined) {
			// T must be a positive finite number — calibration with T <= 0 is
			// undefined behaviour (divide-by-zero or sign flip on logits) and
			// almost certainly a programming error rather than a config the
			// caller wants gracefully ignored.
			if (!Number.isFinite(temperatureT) || temperatureT <= 0) {
				throw new Error(`OnnxClassifier: temperatureT must be a positive finite number, got ${temperatureT}`);
			}
			this.temperatureT = temperatureT;
		}
	}

	/** Current temperature scaling factor (1.0 = no calibration). */
	getTemperature(): number {
		return this.temperatureT;
	}

	/**
	 * Output mode of the loaded model. `null` until the first inference runs.
	 * `"multi"` indicates the model emits `[batch, 2]` (main + aux) logits.
	 */
	getOutputMode(): "single" | "multi" | null {
		return this.outputMode;
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
			console.warn(
				"[defender] ONNX model failed to load:",
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}

	private async _loadModel(): Promise<void> {
		const cached = _sessionCache.get(this.modelPath);
		if (cached) {
			this.session = cached.session;
			this.OrtTensor = cached.OrtTensor;
			this.tokenizer = cached.tokenizer;
			return;
		}

		// Share a single in-flight load across concurrent instances targeting the same path
		let inFlight = _loadingPromises.get(this.modelPath);
		if (!inFlight) {
			const modelPath = this.modelPath;
			inFlight = (async () => {
				// Dynamic imports — these are optional peer dependencies
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const transformers = (await import("@huggingface/transformers")) as unknown as {
					AutoTokenizer: {
						from_pretrained: (path: string, options?: { local_files_only: boolean }) => Promise<Tokenizer>;
					};
				};
				const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelPath, {
					local_files_only: true,
				});

				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const ort = (await import("onnxruntime-node")) as unknown as {
					InferenceSession: {
						create: (path: string) => Promise<OrtInferenceSession>;
					};
					Tensor: OrtTensorConstructor;
				};
				const OrtTensor = ort.Tensor;
				const onnxPath = resolve(modelPath, "model_quantized.onnx");
				const session = await ort.InferenceSession.create(onnxPath);

				_sessionCache.set(modelPath, { session, OrtTensor, tokenizer });
			})();
			_loadingPromises.set(this.modelPath, inFlight);
			// Swallow .finally() rejection — the actual error propagates via `await inFlight` below.
			// Without this, a rejected inFlight produces an unhandled rejection from the .finally() chain.
			inFlight.finally(() => _loadingPromises.delete(this.modelPath)).catch(() => {});
		}

		await inFlight;

		const loaded = _sessionCache.get(this.modelPath);
		if (loaded) {
			this.session = loaded.session;
			this.OrtTensor = loaded.OrtTensor;
			this.tokenizer = loaded.tokenizer;
		}
	}

	/**
	 * Classify a single text, returning the main-head sigmoid score in [0, 1].
	 * Higher values indicate higher probability of prompt injection.
	 *
	 * For multi-head models, only the main score is returned. Callers that
	 * need the aux score should use `classifyPair()`.
	 *
	 * @param text - Text to classify
	 * @returns Sigmoid score in [0, 1]
	 */
	async classify(text: string): Promise<number> {
		const { main } = await this.classifyPair(text);
		return main;
	}

	/**
	 * Classify a single text, returning both main and aux head scores.
	 *
	 * For single-head models, `aux` is `null`.
	 * For multi-head `[batch, 2]` models, both scores are sigmoid-activated.
	 *
	 * @param text - Text to classify
	 * @returns `{ main, aux }` — main in [0,1]; aux in [0,1] or null
	 */
	async classifyPair(text: string): Promise<{ main: number; aux: number | null }> {
		await this.ensureLoaded();

		const { inputIds, attentionMask } = this.tokenize(text);

		if (!this.OrtTensor) {
			throw new Error("OrtTensor not loaded");
		}

		const inputIdsTensor = new this.OrtTensor("int64", inputIds, [1, inputIds.length]);
		const attentionMaskTensor = new this.OrtTensor("int64", attentionMask, [1, attentionMask.length]);

		const results = await this.session?.run({
			input_ids: inputIdsTensor,
			attention_mask: attentionMaskTensor,
		});

		const logits = results?.logits;
		if (!logits || logits.data[0] === undefined || logits.data[0] === null) {
			throw new Error("ONNX model returned no logits");
		}

		this.detectOutputMode(logits.dims);

		const T = this.temperatureT;
		if (this.outputMode === "multi") {
			const main = sigmoid(Number(logits.data[0]) / T);
			const aux = sigmoid(Number(logits.data[1]) / T);
			return { main, aux };
		}
		return { main: sigmoid(Number(logits.data[0]) / T), aux: null };
	}

	/**
	 * Update `outputMode` from a logits-tensor shape on the first inference.
	 * Idempotent — subsequent calls with the same shape are no-ops.
	 */
	private detectOutputMode(dims: number[] | undefined): void {
		if (this.outputMode !== null) return;
		// `dims` may be undefined on hand-rolled mocks; fall back to single-head.
		if (!dims || dims.length < 2) {
			this.outputMode = "single";
			return;
		}
		this.outputMode = dims[1] === 2 ? "multi" : "single";
	}

	/**
	 * Maximum number of texts per ONNX inference call.
	 * Caps native memory from attention matrices: O(chunkSize × seqLen²).
	 * For MiniLM (maxLength=256), chunk=32 keeps memory under ~50MB per call.
	 */
	private static readonly MAX_BATCH_CHUNK = 32;

	/**
	 * Classify multiple texts in batch, processing in chunks to bound memory.
	 * Returns main-head scores only (back-compat). Use `classifyBatchPair()`
	 * when aux scores are needed.
	 *
	 * @param texts - Array of texts to classify
	 * @returns Array of main-head sigmoid scores in [0, 1]
	 */
	async classifyBatch(texts: string[]): Promise<number[]> {
		const pairs = await this.classifyBatchPair(texts);
		return pairs.map((p) => p.main);
	}

	/**
	 * Classify multiple texts in batch, returning main+aux scores.
	 * Aux is `null` per-row for single-head models.
	 *
	 * @param texts - Array of texts to classify
	 * @returns Array of `{ main, aux }`
	 */
	async classifyBatchPair(texts: string[]): Promise<Array<{ main: number; aux: number | null }>> {
		if (texts.length === 0) return [];

		await this.ensureLoaded();

		const allPairs: Array<{ main: number; aux: number | null }> = [];

		for (let offset = 0; offset < texts.length; offset += OnnxClassifier.MAX_BATCH_CHUNK) {
			const chunk = texts.slice(offset, offset + OnnxClassifier.MAX_BATCH_CHUNK);
			const chunkPairs = await this.classifyBatchChunkPair(chunk);
			allPairs.push(...chunkPairs);
		}

		return allPairs;
	}

	/**
	 * Classify a single chunk of texts in one ONNX session.run() call.
	 * Handles both single-head `[batch]`/`[batch, 1]` and multi-head `[batch, 2]`
	 * outputs; the latter returns paired (main, aux) sigmoid scores.
	 */
	private async classifyBatchChunkPair(texts: string[]): Promise<Array<{ main: number; aux: number | null }>> {
		const tokenized = texts.map((t) => this.tokenize(t));
		const maxLen = Math.max(...tokenized.map((t) => t.inputIds.length));

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
		}

		if (!this.OrtTensor) {
			throw new Error("OrtTensor not loaded");
		}

		const inputIdsTensor = new this.OrtTensor("int64", batchInputIds, [batchSize, maxLen]);
		const attentionMaskTensor = new this.OrtTensor("int64", batchAttentionMask, [batchSize, maxLen]);

		const results = await this.session?.run({
			input_ids: inputIdsTensor,
			attention_mask: attentionMaskTensor,
		});

		const logits = results?.logits;
		if (!logits) {
			throw new Error("ONNX model returned no logits");
		}

		this.detectOutputMode(logits.dims);

		const T = this.temperatureT;
		const pairs: Array<{ main: number; aux: number | null }> = [];
		if (this.outputMode === "multi") {
			// Row-major [batch, 2]: [main_0, aux_0, main_1, aux_1, ...]
			for (let i = 0; i < batchSize; i++) {
				const main = sigmoid(Number(logits.data[i * 2]) / T);
				const aux = sigmoid(Number(logits.data[i * 2 + 1]) / T);
				pairs.push({ main, aux });
			}
		} else {
			for (let i = 0; i < batchSize; i++) {
				pairs.push({ main: sigmoid(Number(logits.data[i]) / T), aux: null });
			}
		}
		return pairs;
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
	 * Count tokens in a text WITHOUT truncation, including special tokens
	 * ([CLS] and [SEP] for BERT-family). Used by Tier 2 packing to decide
	 * whether a string fits within the model's max_length and to size
	 * sentence chunks.
	 */
	countTokens(text: string): number {
		if (!this.tokenizer) {
			throw new Error("Tokenizer not loaded. Call loadModel() first.");
		}
		const encoded = this.tokenizer(text, {
			padding: false,
			truncation: false,
			return_tensor: false,
		});
		const rawIds: bigint[] = Array.isArray(encoded.input_ids)
			? (encoded.input_ids as bigint[][]).flat()
			: (encoded.input_ids as { tolist: () => bigint[][] }).tolist().flat();
		return rawIds.length;
	}

	/** Model's maximum input length (in tokens), including special tokens. */
	getMaxLength(): number {
		return this.maxLength;
	}

	/**
	 * Tokenize a single text into BigInt64Arrays for ONNX Runtime.
	 */
	private tokenize(text: string): {
		inputIds: BigInt64Array;
		attentionMask: BigInt64Array;
	} {
		if (!this.tokenizer) {
			throw new Error("Tokenizer not loaded. Call loadModel() first.");
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
