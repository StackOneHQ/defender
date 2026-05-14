/**
 * Tier 2 Classifier: ML-based prompt injection detection
 *
 * ONNX pipeline: text -> Tokenizer -> ONNX Runtime (fine-tuned MiniLM + head) -> logit -> sigmoid -> score
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Tier2Result } from "../types";
import { stripBoundaryPatterns } from "../utils/boundary";
import { getDefaultModelPath, OnnxClassifier } from "./onnx-classifier";

/**
 * Subset of the bundled model's `classifier_config.json` that defender cares
 * about for runtime defaults. Other keys (training metadata, dataset list,
 * architecture flags) are ignored.
 */
interface ModelCalibrationDefaults {
	temperatureT?: number;
	highRiskThreshold?: number;
	mediumRiskThreshold?: number;
}

/**
 * Module-level memo of `classifier_config.json` per model directory.
 * Bundled model assets are immutable at runtime, so the sync FS read +
 * JSON.parse can be amortized to once per process per modelDir — without
 * this cache, every `new Tier2Classifier(...)` on a request hot path
 * blocks the event loop for the read. Mirrors the `_sessionCache` pattern
 * in onnx-classifier.ts. `null` is a valid cached value ("no calibration
 * block for this model"), so probe with `.has()` rather than `=== undefined`.
 */
const _calibrationCache = new Map<string, ModelCalibrationDefaults | null>();

/**
 * Read calibration defaults from a model's `classifier_config.json`, if
 * present. Returns `null` for missing file (legacy models) or absent
 * `calibration` key. Other read or parse failures emit a warning so they
 * don't silently fall back to library defaults — a typo in a shipped
 * calibration block would otherwise be invisible until someone digs into
 * decision divergence. Memoized per modelDir; subsequent calls are O(1).
 */
function readCalibrationDefaults(modelDir: string): ModelCalibrationDefaults | null {
	if (_calibrationCache.has(modelDir)) {
		return _calibrationCache.get(modelDir) ?? null;
	}
	const configPath = resolve(modelDir, "classifier_config.json");
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			console.warn(`[defender] failed to read ${configPath}:`, err instanceof Error ? err.message : String(err));
		}
		_calibrationCache.set(modelDir, null);
		return null;
	}
	try {
		const data = JSON.parse(raw) as { calibration?: ModelCalibrationDefaults };
		const result = data.calibration ?? null;
		_calibrationCache.set(modelDir, result);
		return result;
	} catch (err) {
		console.warn(
			`[defender] malformed classifier_config.json at ${configPath}:`,
			err instanceof Error ? err.message : String(err),
		);
		_calibrationCache.set(modelDir, null);
		return null;
	}
}

/**
 * Multi-head decision rule. When set, the Tier 2 classifier interprets the
 * model's output as `[main, aux]` and blocks iff
 * `main >= mainThreshold AND aux < auxThreshold`.
 *
 * `aux` is interpreted as "directive targets a human reader" — a high aux
 * vetos the block on the assumption that high-main content (imperative,
 * obligation phrasing) is meant for a person, not the assistant.
 *
 * **Threshold selection matters.** Both fields are required (no library
 * default) because the right operating point depends on the model and the
 * caller's traffic distribution. For the bundled default model, FP-benchmark
 * validation gives `{ mainThreshold: 0.5, auxThreshold: 0.64 }`. Lower
 * `auxThreshold` (e.g. 0.3) over-rescues attacks on broader benchmarks —
 * see `evals/RESULTS.md` before picking a different value.
 */
export interface MultiheadConfig {
	/**
	 * Main-head threshold. Block requires the main score to be at or above
	 * this value. Required — no library default.
	 */
	mainThreshold: number;
	/**
	 * Aux-head veto threshold. The rule rescues content from a block when
	 * the aux score is at or above this value. Required — no library default.
	 */
	auxThreshold: number;
}

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
	/** Path to ONNX model directory (defaults to bundled model) */
	onnxModelPath?: string;
	/**
	 * Multi-head decision rule. Set this when pointing the classifier at a
	 * dual-head ONNX model (output shape `[batch, 2]`); leave undefined for
	 * single-head models — the runtime auto-detects shape on first inference.
	 */
	multihead?: MultiheadConfig;
	/**
	 * Advanced: override only when shipping a custom ONNX model. The bundled
	 * model auto-loads its fitted T from `classifier_config.json`; most
	 * callers should not set this.
	 */
	temperatureT?: number;
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
 * Tier 2 Classifier using fine-tuned ONNX MiniLM model
 *
 * Usage:
 * ```typescript
 * const classifier = new Tier2Classifier();
 * await classifier.warmup(); // loads ONNX model + tokenizer
 *
 * const result = await classifier.classify("Ignore previous instructions");
 * console.log(result.score); // 0.95 (high = likely injection)
 * ```
 */
export class Tier2Classifier {
	private config: Tier2ClassifierConfig;
	private onnxClassifier: OnnxClassifier;

	constructor(config: Partial<Tier2ClassifierConfig> = {}) {
		// Three-tier precedence for thresholds and temperature:
		//   1. Hardcoded library defaults (DEFAULT_TIER2_CLASSIFIER_CONFIG)
		//   2. Model-specific defaults from `<modelDir>/classifier_config.json:calibration`
		//   3. Caller-provided `config` (always wins)
		//
		// Model-specific defaults let us ship v5 with `temperatureT: 2.41` and
		// `highRiskThreshold: 0.64` baked in without the library needing to
		// know which model the caller is loading. Legacy models without a
		// classifier_config.json (e.g. `minilm-full-aug`) skip step 2.
		const modelDir = config.onnxModelPath ?? getDefaultModelPath();
		const modelDefaults = readCalibrationDefaults(modelDir);
		const merged: Tier2ClassifierConfig = { ...DEFAULT_TIER2_CLASSIFIER_CONFIG };
		if (modelDefaults) {
			if (typeof modelDefaults.temperatureT === "number") merged.temperatureT = modelDefaults.temperatureT;
			if (typeof modelDefaults.highRiskThreshold === "number")
				merged.highRiskThreshold = modelDefaults.highRiskThreshold;
			if (typeof modelDefaults.mediumRiskThreshold === "number")
				merged.mediumRiskThreshold = modelDefaults.mediumRiskThreshold;
		}
		// Caller config wins, but filter out explicit `undefined` keys first.
		// A naive `{ ...merged, ...config }` would let `{ temperatureT: undefined }`
		// (common when building config conditionally from optional settings)
		// silently clobber a model-loaded calibration value — and an undefined
		// `temperatureT` then bypasses OnnxClassifier's positive-finite guard,
		// dropping calibration back to T=1.
		const definedConfig = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined));
		this.config = { ...merged, ...definedConfig };
		this.onnxClassifier = new OnnxClassifier(this.config.onnxModelPath, this.config.temperatureT);
	}

	/**
	 * Check if the classifier is ready for inference
	 */
	isReady(): boolean {
		return this.onnxClassifier.isLoaded();
	}

	/**
	 * Pre-load the ONNX model + tokenizer.
	 *
	 * Call this at startup to avoid latency on first classify() call.
	 */
	async warmup(): Promise<void> {
		await this.onnxClassifier.warmup();
	}

	/**
	 * Classify a single text for prompt injection
	 *
	 * @param text - Text to classify
	 * @returns Tier2Result with score, confidence, and timing
	 */
	async classify(text: string): Promise<Tier2Result> {
		const startTime = performance.now();

		// Strip defender's own boundary markers before tokenization. Upstream
		// callers (or nested tool-call chains) may feed us output that was
		// previously wrapped with `[UD-<id>]...[/UD-<id>]`; those tokens
		// corrupt per-sentence scores because the tokenizer counts them as
		// part of the sentence. Also strips spoofed boundary patterns an
		// attacker might inject to confuse downstream LLM trust.
		text = stripBoundaryPatterns(text);

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
			const score = await this.onnxClassifier.classify(analysisText);
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
				skipReason: `Classification error: ${error instanceof Error ? error.message : String(error)}`,
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

		// See comment in `classify()` — strip boundary markers before sentence
		// splitting so tag tokens don't corrupt per-sentence scores.
		text = stripBoundaryPatterns(text);

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

		// Filter and truncate sentences
		const classifiableSentences: string[] = [];
		const originalSentences: string[] = [];
		for (const sentence of sentences) {
			if (sentence.length < this.config.minTextLength) {
				continue;
			}
			originalSentences.push(sentence);
			classifiableSentences.push(
				sentence.length > this.config.maxTextLength ? sentence.slice(0, this.config.maxTextLength) : sentence,
			);
		}

		if (classifiableSentences.length === 0) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: "No classifiable sentences",
				latencyMs: performance.now() - startTime,
			};
		}

		// Batch classify all sentences in a single ONNX call
		let scores: number[];
		try {
			scores = await this.onnxClassifier.classifyBatch(classifiableSentences);
		} catch (err) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: `Classification error: ${err instanceof Error ? err.message : String(err)}`,
				latencyMs: performance.now() - startTime,
			};
		}

		const sentenceScores: Array<{ sentence: string; score: number }> = [];
		let maxScore = 0;
		let maxSentence = "";

		for (let i = 0; i < scores.length; i++) {
			const rawScore = scores[i];
			const score = Number.isFinite(rawScore) ? rawScore : 0;
			const sentence = originalSentences[i] ?? "";
			sentenceScores.push({ sentence, score });
			if (score > maxScore) {
				maxScore = score;
				maxSentence = sentence;
			}
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
	 * Classify text using sentence-packed chunks.
	 *
	 * Fast path: if the full text fits in the model's max_length, classify as
	 * one inference — preserves full cross-sentence context.
	 *
	 * Long-text path: sentences are split and greedy-packed into chunks, each
	 * fitting within max_length. Max score across chunks is returned. Within
	 * each chunk, the model retains cross-sentence context — so roleplay /
	 * payload-splitting / multi-agent attacks that span multiple sentences
	 * are detected (unlike per-sentence classification which loses context).
	 */
	async classifyByChunks(text: string): Promise<
		Tier2Result & {
			maxSentence?: string;
			sentenceScores?: Array<{ sentence: string; score: number }>;
		}
	> {
		const startTime = performance.now();

		// See comment in `classify()` — strip boundary markers before sizing
		// and tokenization so self-wrapped / spoofed tags don't corrupt scores.
		text = stripBoundaryPatterns(text);

		if (text.length < this.config.minTextLength) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: "Text below minTextLength",
				latencyMs: performance.now() - startTime,
			};
		}

		const modelMaxLen = this.onnxClassifier.getMaxLength();

		// Respect maxTextLength — tokenising a huge payload before the
		// fast-path check would burn CPU/memory unbounded. Truncate to
		// `maxTextLength` characters first; anything past that cannot fit
		// in the model anyway (256 tokens ≪ 10 000 chars).
		const bounded = text.length > this.config.maxTextLength ? text.slice(0, this.config.maxTextLength) : text;

		// countTokens requires the tokenizer loaded; classify auto-loads, so
		// warm up here to mirror that behaviour for the packing path.
		try {
			await this.onnxClassifier.warmup();
		} catch (err) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: `Warmup error: ${err instanceof Error ? err.message : String(err)}`,
				latencyMs: performance.now() - startTime,
			};
		}

		let totalTokens: number;
		try {
			totalTokens = this.onnxClassifier.countTokens(bounded);
		} catch (err) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: `Token count error: ${err instanceof Error ? err.message : String(err)}`,
				latencyMs: performance.now() - startTime,
			};
		}

		// Fast path: full text fits — classify as-is, preserving full context.
		if (totalTokens <= modelMaxLen) {
			let score: number;
			try {
				score = await this.onnxClassifier.classify(bounded);
			} catch (err) {
				return {
					score: 0,
					confidence: 0,
					skipped: true,
					skipReason: `Classification error: ${err instanceof Error ? err.message : String(err)}`,
					latencyMs: performance.now() - startTime,
				};
			}
			const safeScore = Number.isFinite(score) ? score : 0;
			return {
				score: safeScore,
				confidence: Math.abs(safeScore - 0.5) * 2,
				skipped: false,
				maxSentence: bounded,
				sentenceScores: [{ sentence: bounded, score: safeScore }],
				latencyMs: performance.now() - startTime,
			};
		}

		// Long-text path: pack sentences into chunks that fit in modelMaxLen.
		// Reserve 2 tokens per chunk for [CLS] + [SEP].
		const maxContentTokens = modelMaxLen - 2;

		const sentences = this.splitIntoSentences(bounded).filter((s) => s.length >= this.config.minTextLength);
		if (sentences.length === 0) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: "No classifiable sentences",
				latencyMs: performance.now() - startTime,
			};
		}

		const chunks = this.packSentences(sentences, maxContentTokens);
		let scores: number[];
		try {
			scores = await this.onnxClassifier.classifyBatch(chunks);
		} catch (err) {
			return {
				score: 0,
				confidence: 0,
				skipped: true,
				skipReason: `Classification error: ${err instanceof Error ? err.message : String(err)}`,
				latencyMs: performance.now() - startTime,
			};
		}

		let maxScore = 0;
		let maxChunk = "";
		const chunkScores: Array<{ sentence: string; score: number }> = [];
		for (let i = 0; i < scores.length; i++) {
			const raw = scores[i];
			const safeScore = Number.isFinite(raw) ? raw : 0;
			const chunk = chunks[i] ?? "";
			chunkScores.push({ sentence: chunk, score: safeScore });
			if (safeScore > maxScore) {
				maxScore = safeScore;
				maxChunk = chunk;
			}
		}

		return {
			score: maxScore,
			confidence: Math.abs(maxScore - 0.5) * 2,
			skipped: false,
			maxSentence: maxChunk,
			sentenceScores: chunkScores,
			latencyMs: performance.now() - startTime,
		};
	}

	/**
	 * Compute the chunks that classifyByChunks() would classify for a given
	 * text, WITHOUT invoking the ONNX model. Lets callers with many strings
	 * to score batch them together in a single ONNX inference — restoring
	 * v0.5.8-style throughput while keeping v0.6's per-string integrity.
	 *
	 * Returns `{ chunks: [], skipped: true, skipReason }` when the text
	 * cannot be classified (too short, no sentences long enough to classify,
	 * token-count or warmup failure).
	 */
	async prepareChunks(text: string): Promise<{
		chunks: string[];
		skipped: boolean;
		skipReason?: string;
	}> {
		// See comment in `classify()` — strip boundary markers before sizing
		// and tokenization so self-wrapped / spoofed tags don't corrupt scores.
		text = stripBoundaryPatterns(text);

		if (text.length < this.config.minTextLength) {
			return { chunks: [], skipped: true, skipReason: "Text below minTextLength" };
		}
		const modelMaxLen = this.onnxClassifier.getMaxLength();
		const bounded = text.length > this.config.maxTextLength ? text.slice(0, this.config.maxTextLength) : text;

		try {
			await this.onnxClassifier.warmup();
		} catch (err) {
			return {
				chunks: [],
				skipped: true,
				skipReason: `Warmup error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		// Fast path: WordPiece cannot emit more tokens than input chars (worst
		// case each char is a single-char subword or [UNK]), plus 2 specials
		// ([CLS]/[SEP]). If that upper bound already fits, skip the countTokens
		// tokenizer round-trip — a material win on list payloads full of
		// short-to-medium field values. Warmup still runs so failures surface
		// here (fail-safe) rather than propagating out of classifyChunksBatch.
		if (bounded.length + 2 <= modelMaxLen) {
			return { chunks: [bounded], skipped: false };
		}

		let totalTokens: number;
		try {
			totalTokens = this.onnxClassifier.countTokens(bounded);
		} catch (err) {
			return {
				chunks: [],
				skipped: true,
				skipReason: `Token count error: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		if (totalTokens <= modelMaxLen) {
			return { chunks: [bounded], skipped: false };
		}

		const maxContentTokens = modelMaxLen - 2;
		const sentences = this.splitIntoSentences(bounded).filter((s) => s.length >= this.config.minTextLength);
		if (sentences.length === 0) {
			return { chunks: [], skipped: true, skipReason: "No classifiable sentences" };
		}
		return { chunks: this.packSentences(sentences, maxContentTokens), skipped: false };
	}

	/**
	 * Classify an arbitrary batch of already-prepared chunks in a SINGLE
	 * ONNX call. Used by the per-string batching path in `defendToolResult`
	 * to amortise per-call thread-spin-up over many chunks.
	 */
	async classifyChunksBatch(chunks: string[]): Promise<number[]> {
		if (chunks.length === 0) return [];
		await this.onnxClassifier.warmup();
		return this.onnxClassifier.classifyBatch(chunks);
	}

	/**
	 * Multi-head variant of `classifyChunksBatch`. Returns paired `(main, aux)`
	 * scores per chunk. For single-head models, `aux` is `null` per row.
	 * Callers in the multi-head path use the aux scores to apply the veto rule.
	 */
	async classifyChunksBatchPair(chunks: string[]): Promise<Array<{ main: number; aux: number | null }>> {
		if (chunks.length === 0) return [];
		await this.onnxClassifier.warmup();
		return this.onnxClassifier.classifyBatchPair(chunks);
	}

	/**
	 * Temperature scaling factor in use (1.0 = no calibration). Exposed so
	 * the cumulative-density and risk-bucketing code in PromptDefense can
	 * rescale its thresholds into calibrated-score space when T != 1.
	 */
	getTemperature(): number {
		return this.onnxClassifier.getTemperature();
	}

	/**
	 * Whether this classifier is configured for multi-head decision-making.
	 * Returns false when no `multihead` config was provided, regardless of
	 * what the underlying ONNX model emits.
	 */
	isMultihead(): boolean {
		return this.config.multihead !== undefined;
	}

	/**
	 * The configured multi-head thresholds, or `undefined` when not configured.
	 */
	getMultiheadConfig(): MultiheadConfig | undefined {
		return this.config.multihead;
	}

	/**
	 * Greedy sentence packer — returns chunks each fitting within maxContentTokens.
	 * Sentences exceeding maxContentTokens become their own chunk and are
	 * truncated by the tokenizer at inference (best effort on pathological input).
	 */
	private packSentences(sentences: string[], maxContentTokens: number): string[] {
		const chunks: string[] = [];
		let current: string[] = [];
		let currentTokens = 0;

		for (const s of sentences) {
			const sTokens = this.onnxClassifier.countTokens(s);
			// countTokens includes [CLS]+[SEP]; subtract to get content cost when packing.
			const sContentTokens = Math.max(0, sTokens - 2);

			if (sContentTokens > maxContentTokens) {
				if (current.length > 0) {
					chunks.push(current.join(" "));
					current = [];
					currentTokens = 0;
				}
				chunks.push(s);
				continue;
			}

			// BERT/WordPiece tokenisers (which all our bundled MiniLM
			// variants use) do NOT emit a separate token for inter-word
			// whitespace — "hello world" and "hello" "world" joined give
			// the same ["hello", "world"] sequence. So a sentence's
			// content token count adds directly to the running chunk
			// count without any extra "joiner" cost. This avoids
			// underpacking: the previous `joinerCost = 1` overestimate
			// forced extra chunk boundaries (and extra ONNX inferences)
			// on long payloads.
			if (currentTokens + sContentTokens > maxContentTokens) {
				chunks.push(current.join(" "));
				current = [s];
				currentTokens = sContentTokens;
			} else {
				current.push(s);
				currentTokens += sContentTokens;
			}
		}

		if (current.length > 0) {
			chunks.push(current.join(" "));
		}
		return chunks;
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
}

/**
 * Create a Tier 2 classifier instance
 */
export function createTier2Classifier(config?: Partial<Tier2ClassifierConfig>): Tier2Classifier {
	return new Tier2Classifier(config);
}
