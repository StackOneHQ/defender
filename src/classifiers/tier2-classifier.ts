/**
 * Tier 2 Classifier: ML-based prompt injection detection
 *
 * Supports two modes:
 * - 'onnx': Fine-tuned MiniLM end-to-end ONNX inference (default, higher accuracy)
 * - 'mlp': Frozen embeddings + MLP head (legacy, smaller download)
 *
 * ONNX pipeline: text -> Tokenizer -> ONNX Runtime (fine-tuned MiniLM + head) -> logit -> sigmoid -> score
 * MLP pipeline:  text -> Embedder (generic MiniLM) -> 384-dim -> MLP forward pass -> sigmoid -> score
 */

import type { Tier2Result } from "../types";
import { createEmbedder, type Embedder, type EmbedderConfig } from "./embedder";
import { loadMLPWeights, type MLPModel, type MLPWeights, mlpForward } from "./mlp";
import { OnnxClassifier } from "./onnx-classifier";

/**
 * Tier 2 classifier configuration
 */
export interface Tier2ClassifierConfig {
	/** Inference mode: 'onnx' for fine-tuned MiniLM, 'mlp' for frozen embeddings + MLP head */
	mode: "mlp" | "onnx";
	/** Score threshold for high risk (default: 0.8) */
	highRiskThreshold: number;
	/** Score threshold for medium risk (default: 0.5) */
	mediumRiskThreshold: number;
	/** Minimum text length to classify (shorter texts are skipped) */
	minTextLength: number;
	/** Maximum text length to classify (longer texts are truncated) */
	maxTextLength: number;
	/** Embedder configuration (MLP mode only) */
	embedder?: Partial<EmbedderConfig>;
	/** Path to ONNX model directory (ONNX mode only, defaults to bundled model) */
	onnxModelPath?: string;
}

/**
 * Default Tier 2 configuration
 */
export const DEFAULT_TIER2_CLASSIFIER_CONFIG: Tier2ClassifierConfig = {
	mode: "onnx",
	highRiskThreshold: 0.8,
	mediumRiskThreshold: 0.5,
	minTextLength: 10,
	maxTextLength: 10000,
};

/**
 * Tier 2 Classifier using ONNX or MLP + embeddings
 *
 * Usage (ONNX mode - default):
 * ```typescript
 * const classifier = new Tier2Classifier();
 * await classifier.warmup(); // loads ONNX model + tokenizer
 *
 * const result = await classifier.classify("Ignore previous instructions");
 * console.log(result.score); // 0.95 (high = likely injection)
 * ```
 *
 * Usage (MLP mode - legacy):
 * ```typescript
 * const classifier = new Tier2Classifier({ mode: 'mlp' });
 * classifier.loadWeights(weightsJson);
 * await classifier.warmup(); // pre-load embedding model
 *
 * const result = await classifier.classify("Ignore previous instructions");
 * ```
 */
export class Tier2Classifier {
	private config: Tier2ClassifierConfig;
	private embedder: Embedder | null = null;
	private model: MLPModel | null = null;
	private onnxClassifier: OnnxClassifier | null = null;

	constructor(config: Partial<Tier2ClassifierConfig> = {}) {
		this.config = { ...DEFAULT_TIER2_CLASSIFIER_CONFIG, ...config };

		if (this.config.mode === "mlp") {
			this.embedder = createEmbedder(config.embedder);
		} else {
			this.onnxClassifier = new OnnxClassifier(this.config.onnxModelPath);
		}
	}

	/**
	 * Load MLP weights from exported JSON (MLP mode only)
	 *
	 * @param weights - Weights exported from export_mlp_weights.py
	 */
	loadWeights(weights: MLPWeights): void {
		if (this.config.mode === "onnx") {
			// No-op for ONNX mode — weights are baked into the ONNX model
			return;
		}
		this.model = loadMLPWeights(weights);
	}

	/**
	 * Check if the classifier is ready for inference
	 */
	isReady(): boolean {
		if (this.config.mode === "onnx") {
			return this.onnxClassifier?.isLoaded() ?? false;
		}
		return this.model !== null;
	}

	/**
	 * Check if embedding model is loaded (MLP mode only)
	 */
	isEmbedderLoaded(): boolean {
		if (this.config.mode === "onnx") {
			return this.onnxClassifier?.isLoaded() ?? false;
		}
		return this.embedder?.isLoaded() ?? false;
	}

	/**
	 * Pre-load the model.
	 * - ONNX mode: loads ONNX model + tokenizer
	 * - MLP mode: pre-loads the embedding model
	 *
	 * Call this at startup to avoid latency on first classify() call.
	 */
	async warmup(): Promise<void> {
		if (this.config.mode === "onnx") {
			await this.onnxClassifier?.warmup();
		} else {
			await this.embedder?.warmup();
		}
	}

	/**
	 * Classify a single text for prompt injection
	 *
	 * @param text - Text to classify
	 * @returns Tier2Result with score, confidence, and timing
	 */
	async classify(text: string): Promise<Tier2Result> {
		const startTime = performance.now();

		// Check readiness
		if (this.config.mode === "onnx") {
			if (!this.onnxClassifier) {
				return {
					score: 0,
					confidence: 0,
					skipped: true,
					skipReason: "ONNX classifier not initialized",
					latencyMs: performance.now() - startTime,
				};
			}
		} else {
			if (!this.model) {
				return {
					score: 0,
					confidence: 0,
					skipped: true,
					skipReason: "MLP weights not loaded",
					latencyMs: performance.now() - startTime,
				};
			}
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
		const analysisText = text.length > this.config.maxTextLength ? text.slice(0, this.config.maxTextLength) : text;

		try {
			let score: number;

			if (this.config.mode === "onnx") {
				score = (await this.onnxClassifier?.classify(analysisText)) ?? 0;
			} else {
				// MLP mode: embed then forward pass
				const embedding = await this.embedder?.embedOne(analysisText);
				if (!this.model || !embedding) {
					throw new Error("MLP model or embedder not available");
				}
				score = mlpForward(this.model, embedding);
			}

			// Calculate confidence based on how far from 0.5 the score is
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
	async classifyBySentence(text: string): Promise<
		Tier2Result & {
			maxSentence?: string;
			sentenceScores?: Array<{ sentence: string; score: number }>;
		}
	> {
		const startTime = performance.now();

		// Check readiness
		const notReady = this.config.mode === "onnx" ? !this.onnxClassifier : !this.model;

		if (notReady) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: this.config.mode === "onnx" ? "ONNX classifier not initialized" : "MLP weights not loaded",
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
				skipReason: "No sentences found",
				latencyMs: performance.now() - startTime,
			};
		}

		// Classify each sentence
		const sentenceScores: Array<{ sentence: string; score: number }> = [];
		let maxScore = 0;
		let maxSentence = "";

		for (const sentence of sentences) {
			if (sentence.length < this.config.minTextLength) {
				continue;
			}

			try {
				let score: number;

				if (this.config.mode === "onnx") {
					score = (await this.onnxClassifier?.classify(sentence)) ?? 0;
				} else {
					const embedding = await this.embedder?.embedOne(sentence);
					if (!this.model || !embedding) {
						throw new Error("MLP model or embedder not available");
					}
					score = mlpForward(this.model, embedding);
				}

				sentenceScores.push({ sentence, score });

				if (score > maxScore) {
					maxScore = score;
					maxSentence = sentence;
				}
			} catch {}
		}

		if (sentenceScores.length === 0) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: "No classifiable sentences",
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
				if (trimmed.length > 200 && trimmed.includes("\n")) {
					const subChunks = trimmed.split("\n");
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
	getRiskLevel(score: number): "low" | "medium" | "high" {
		if (score >= this.config.highRiskThreshold) {
			return "high";
		}
		if (score >= this.config.mediumRiskThreshold) {
			return "medium";
		}
		return "low";
	}

	/**
	 * Get current configuration
	 */
	getConfig(): Tier2ClassifierConfig {
		return { ...this.config };
	}

	/**
	 * Get the underlying embedder (MLP mode only, returns null in ONNX mode)
	 */
	getEmbedder(): Embedder | null {
		return this.embedder;
	}
}

/**
 * Create a Tier 2 classifier instance
 */
export function createTier2Classifier(config?: Partial<Tier2ClassifierConfig>): Tier2Classifier {
	return new Tier2Classifier(config);
}
