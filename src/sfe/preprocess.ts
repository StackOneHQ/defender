/**
 * Semantic Field Extractor (SFE) preprocessor — FastText classifier.
 *
 * Filters benign metadata / identifier fields out of tool-result payloads
 * before Tier 1 and Tier 2 classification, reducing false positives on
 * structured-response payloads without affecting attack detection on
 * user-facing content (the classifier is trained to pass strings that
 * look like user content, drop strings that look like identifiers, enum
 * codes, hash-like metadata, etc.).
 *
 * Measured impact (v4 ONNX + rules ∪ FT @ 0.5 on 940 benign StackOne
 * connector payloads):
 *   FPs: 9/940 (0.96%) → 3/940 (0.32%)
 *   Latency: 15.2 ms → 11.4 ms
 *
 * See `docs/investigation-*` and stackone-redteaming docs for the full
 * cross-benchmark generalization study.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DANGEROUS_KEYS, MAX_TRAVERSAL_DEPTH } from "../config";

/** Predicate returned by the FastText classifier for each field. */
type DropDecision = { label: "drop" | "pass"; prob: number };

/** Interface that any FastText-compatible predictor must implement. */
export interface SfePredictor {
	/** Predict the most-probable label and its probability for a text. */
	predict(text: string): Promise<DropDecision>;
	/** Predict the most-probable label for each text in a batch. */
	predictBatch(texts: string[]): Promise<DropDecision[]>;
}

/**
 * Default path to the bundled quantized FastText model. Tries several
 * locations so the resolver works in:
 *   - source/dev (`src/sfe/preprocess.ts` → `src/sfe/model.ftz`)
 *   - bundled CJS/ESM (`dist/index.cjs` → `dist/sfe/model.ftz`)
 */
export function getDefaultSfeModelPath(): string {
	let baseDir: string;
	try {
		baseDir = dirname(fileURLToPath(import.meta.url));
	} catch {
		baseDir = __dirname;
	}
	// Prefer sibling sfe/model.ftz (bundled dist layout), fall back to
	// the source layout (model.ftz next to preprocess.ts) when running
	// directly from src. Uses the ESM-safe static import of `existsSync`
	// (the previous `require("node:fs")` call threw in the ESM bundle).
	const candidates = [resolve(baseDir, "sfe", "model.ftz"), resolve(baseDir, "model.ftz")];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	return candidates[0];
}

/**
 * Process-wide predictor cache keyed by resolved model path. The FastText
 * WASM module is expensive to load (~50 ms + 0.7 MB model read), so we
 * share one instance per path across calls.
 */
const _predictorCache = new Map<string, Promise<SfePredictor | null>>();

/**
 * Lazy-load a FastText predictor. Returns `null` if `fasttext.wasm`
 * is not installed OR the model fails to load — the preprocessor
 * falls back to passing payloads through unfiltered. Failures are not
 * permanently cached: each failed load clears its cache entry so a
 * later call can retry after the environment is fixed.
 *
 * Because failures are re-attempted, warnings may be emitted repeatedly
 * — once per call — until the underlying issue is resolved (module
 * installed, file available). This is intentional so operators get
 * telemetry on sustained degraded operation rather than a single
 * startup warning that's easy to miss.
 *
 * @param modelPath - Optional path to a FastText .ftz model. Defaults
 *   to the bundled quantized StackOne SFE model. Different paths get
 *   distinct predictor instances.
 */
export function getDefaultPredictor(modelPath?: string): Promise<SfePredictor | null> {
	const resolved = modelPath ?? getDefaultSfeModelPath();
	const existing = _predictorCache.get(resolved);
	if (existing) return existing;

	const loading = loadPredictor(resolved).catch((err) => {
		// Do not permanently cache a rejected promise — drop it so a later
		// call can retry (e.g. after the missing file is supplied).
		_predictorCache.delete(resolved);
		console.warn(
			`[defender] SFE predictor failed to load (${err instanceof Error ? err.message : String(err)}); payload will pass through.`,
		);
		return null;
	});
	_predictorCache.set(resolved, loading);
	return loading;
}

async function loadPredictor(modelPath: string): Promise<SfePredictor | null> {
	let fasttextMod: typeof import("fasttext.wasm") | null = null;
	try {
		// Wrap the dynamic import in a Function() so bundlers (tsdown /
		// rollup / esbuild) DON'T statically resolve "fasttext.wasm" at
		// bundle time. We need that behavior because `fasttext.wasm` is an
		// optional peer dependency — callers who don't enable useSfe must
		// not be forced to install it, and a static import would either
		// hard-fail at bundle time or emit a resolver error at load time.
		//
		// Safety: the specifier is a hard-coded string literal
		// ("fasttext.wasm"), NOT caller-supplied input. This pattern is
		// semantically identical to `import("fasttext.wasm")` — the
		// Function() indirection only exists to evade bundler static
		// analysis. There is no dynamic code execution or user-controlled
		// string passed to Function() / eval() elsewhere in this module.
		const dynImport = new Function("spec", "return import(spec)") as (s: string) => Promise<unknown>;
		fasttextMod = (await dynImport("fasttext.wasm")) as typeof import("fasttext.wasm");
	} catch {
		console.warn(
			"[defender] useSfe requires `fasttext.wasm` to be installed. SFE preprocessor disabled; payload passes through.",
		);
		return null;
	}

	// Model read + WASM init errors propagate — getDefaultPredictor's
	// catch cleans the cache entry and returns null, so the preprocessor
	// still fails open.
	const ft = await fasttextMod.FastText.create();
	const { readFile } = await import("node:fs/promises");
	const modelBytes = new Uint8Array(await readFile(modelPath));
	ft.loadModel(modelBytes);

	const predict = async (text: string): Promise<DropDecision> => {
		const map = ft.predict(text, 1, 0);
		const entry = map.entries().next().value as [string, number] | undefined;
		if (!entry) return { label: "pass", prob: 0 };
		const [rawLabel, prob] = entry;
		const label = rawLabel.replace(/^__label__/, "") as "drop" | "pass";
		return { label, prob };
	};

	return {
		predict,
		async predictBatch(texts: string[]) {
			// fasttext.wasm doesn't expose a vector batch API; call predict per text.
			// This is fine for our workload (typically <100 strings per payload).
			const out: DropDecision[] = new Array(texts.length);
			for (let i = 0; i < texts.length; i++) {
				out[i] = await predict(texts[i]);
			}
			return out;
		},
	};
}

// ─── Filter logic ────────────────────────────────────────────────────────────

const VALUE_TYPES = ["null", "bool", "int", "float", "string", "array", "object"] as const;

function valueType(v: unknown): (typeof VALUE_TYPES)[number] {
	if (v === null || v === undefined) return "null";
	if (typeof v === "boolean") return "bool";
	if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
	if (typeof v === "string") return "string";
	if (Array.isArray(v)) return "array";
	if (typeof v === "object") return "object";
	return "string";
}

interface Field {
	rawPath: string;
	value: unknown;
	valueType: (typeof VALUE_TYPES)[number];
	valueTruncated: string;
	depth: number;
}

/**
 * Walk the payload and collect leaf fields (anything that's not a
 * container). Only leaf fields are passed to the classifier — the
 * classifier has no concept of "this whole subtree is irrelevant".
 */
function extractFields(obj: unknown, depthFlag: { hit: boolean }, path = "", depth = 0, stackDepth = 0): Field[] {
	// `depth` is the semantic field-path depth fed into the FastText model
	// (must match the training script's counting — arrays don't count as a
	// level of nesting). `stackDepth` counts actual recursive calls for
	// stack-safety; it increments on arrays too, so a pathological
	// [[[[...]]]] payload still trips the cap.
	if (stackDepth > MAX_TRAVERSAL_DEPTH) {
		depthFlag.hit = true;
		return [];
	}
	const out: Field[] = [];
	if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			const child = path ? `${path}.${k}` : k;
			out.push(...extractFields(v, depthFlag, child, depth + 1, stackDepth + 1));
		}
	} else if (Array.isArray(obj)) {
		for (const item of obj) out.push(...extractFields(item, depthFlag, path, depth, stackDepth + 1));
	} else {
		const vt = valueType(obj);
		const truncated = obj === null || obj === undefined ? "" : String(obj).slice(0, 500);
		out.push({
			rawPath: path,
			value: obj,
			valueType: vt,
			valueTruncated: truncated,
			depth,
		});
	}
	return out;
}

/**
 * Encode a field into the text format the FastText model was trained on.
 * Must match `record_to_text()` in solaris-labels/modal_validate_fasttext.py.
 */
function fieldToText(f: Field): string {
	const pathTokens = f.rawPath.replace(/[._-]/g, " ");
	const val = f.valueTruncated.slice(0, 200);
	const text = `${f.valueType} d${f.depth} ${pathTokens} ${val}`;
	return text.replace(/[\r\n]/g, " ");
}

function filterByPaths<T>(obj: T, dropPaths: Set<string>, depthFlag: { hit: boolean }, path = "", depth = 0): T {
	if (depth > MAX_TRAVERSAL_DEPTH) {
		depthFlag.hit = true;
		return obj;
	}
	if (Array.isArray(obj)) {
		const out = new Array(obj.length);
		for (let i = 0; i < obj.length; i++) out[i] = filterByPaths(obj[i], dropPaths, depthFlag, path, depth + 1);
		return out as unknown as T;
	}
	if (obj !== null && typeof obj === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			// Skip prototype-pollution-adjacent keys before copying to `{}`.
			// Mirrors the main sanitizer's DANGEROUS_KEYS treatment.
			if (DANGEROUS_KEYS.has(k)) continue;
			const child = path ? `${path}.${k}` : k;
			out[k] = filterByPaths(v, dropPaths, depthFlag, child, depth + 1);
		}
		return out as unknown as T;
	}
	// Leaf — drop if its path is in dropPaths
	return (dropPaths.has(path) ? (undefined as unknown as T) : obj) as T;
}

// After filtering leaves to undefined, compact: remove undefined values from
// objects, and filter undefined from arrays. Keeps the returned structure
// clean for downstream classification and for the LLM-facing `sanitized` output.
function compactUndefined<T>(obj: T, depthFlag: { hit: boolean }, depth = 0): T {
	if (depth > MAX_TRAVERSAL_DEPTH) {
		depthFlag.hit = true;
		return obj;
	}
	if (Array.isArray(obj)) {
		const filtered = obj.filter((x) => x !== undefined).map((x) => compactUndefined(x, depthFlag, depth + 1));
		return filtered as unknown as T;
	}
	if (obj !== null && typeof obj === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
			if (v === undefined) continue;
			if (DANGEROUS_KEYS.has(k)) continue;
			out[k] = compactUndefined(v, depthFlag, depth + 1);
		}
		return out as unknown as T;
	}
	return obj;
}

export interface SfePreprocessOptions {
	/** FastText predictor. If omitted, the bundled quantized model is used. */
	predictor?: SfePredictor;
	/** Drop threshold: drop a field if P(drop) ≥ threshold. Default 0.5. */
	threshold?: number;
}

export interface SfePreprocessResult<T> {
	/** Payload with drop-classified leaves removed. */
	filtered: T;
	/** Paths of leaves dropped by the classifier. */
	dropped: string[];
	/** True if any internal walk hit MAX_TRAVERSAL_DEPTH. */
	truncatedAtDepth?: boolean;
}

/**
 * Apply the SFE FastText classifier to a payload and drop fields it
 * classifies as "drop" (metadata/identifier content, not user text).
 *
 * Primitive inputs (bare strings / numbers / null) pass through unchanged —
 * the classifier operates at the field-path level, and there are no
 * fields to match.
 */
export async function sfePreprocess<T>(value: T, options: SfePreprocessOptions = {}): Promise<SfePreprocessResult<T>> {
	// Bare primitives have no fields to classify — pass through unchanged.
	// SFE operates at the field level; there's no meaningful preprocessing
	// for a standalone string/number/boolean/null/undefined.
	if (value === null || value === undefined || typeof value !== "object") {
		return { filtered: value, dropped: [] };
	}

	const predictor = options.predictor ?? (await getDefaultPredictor());
	if (!predictor) {
		// FastText runtime not available; pass through without filtering.
		return { filtered: value, dropped: [] };
	}
	const threshold = options.threshold ?? 0.5;

	const depthFlag = { hit: false };
	const fields = extractFields(value, depthFlag);
	const candidates = fields.filter((f) => f.valueType === "string" || f.valueType === "null");
	if (candidates.length === 0) {
		return { filtered: value, dropped: [], truncatedAtDepth: depthFlag.hit || undefined };
	}

	const texts = candidates.map(fieldToText);
	const decisions = await predictor.predictBatch(texts);
	const dropPaths = new Set<string>();
	for (let i = 0; i < candidates.length; i++) {
		const d = decisions[i];
		if (d.label === "drop" && d.prob >= threshold) {
			dropPaths.add(candidates[i].rawPath);
		}
	}

	if (dropPaths.size === 0) {
		return { filtered: value, dropped: [], truncatedAtDepth: depthFlag.hit || undefined };
	}

	// `dropped` is the sorted de-duplicated set of paths (paths from array
	// elements share the element-free path form, so duplicates arise on
	// list-response payloads — we report each distinct path once). Note the
	// all-or-nothing behavior on arrays: when any element's leaf path is
	// classified as drop, the field is removed from every sibling element.
	const dropped = Array.from(dropPaths).sort();

	const filtered = compactUndefined(filterByPaths(value, dropPaths, depthFlag), depthFlag);
	return { filtered, dropped, truncatedAtDepth: depthFlag.hit || undefined };
}
