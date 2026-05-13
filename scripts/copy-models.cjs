#!/usr/bin/env node
/**
 * Mirror bundled model assets from src/ to dist/ after a build.
 *
 * Add new model directories to MODEL_DIRS — each is copied recursively from
 * src/classifiers/models/<name> → dist/models/<name>. Tier 2 callers resolve
 * models via paths relative to the compiled file (which lives at dist/).
 */
const { cpSync, mkdirSync, existsSync, copyFileSync } = require("node:fs");
const { resolve } = require("node:path");

const ROOT = resolve(__dirname, "..");

/**
 * ONNX model directories to mirror under dist/models/. Each entry must exist
 * under `src/classifiers/models/<name>` at build time.
 *
 * The npm package ships a single model — the current default. Other variants
 * (v3, v4c, v6, v31, full-aug) live in the classifier-eval workspace and on
 * the Modal volume for benchmarking, but stay out of the published tarball
 * to keep install size reasonable.
 */
const MODEL_DIRS = [
	// Multi-head v5 — current default. Dual-head ONNX consumed in single-head
	// mode by default; opt into multi-head decision rule via
	// `tier2Config.multihead`. Calibrated T = 2.41, highRiskThreshold = 0.64
	// (encoded in classifier_config.json:calibration).
	"minilm-multihead-v5",
];

let copied = 0;
for (const name of MODEL_DIRS) {
	const src = resolve(ROOT, "src", "classifiers", "models", name);
	const dst = resolve(ROOT, "dist", "models", name);
	if (!existsSync(src)) {
		console.warn(`[copy-models] missing: ${src} — skipping`);
		continue;
	}
	mkdirSync(dst, { recursive: true });
	cpSync(src, dst, { recursive: true });
	console.log(`[copy-models] copied ${name}`);
	copied++;
}

/** SFE FastText model (single file). */
const sfeSrc = resolve(ROOT, "src", "sfe", "model.ftz");
const sfeDst = resolve(ROOT, "dist", "sfe", "model.ftz");
if (existsSync(sfeSrc)) {
	mkdirSync(resolve(ROOT, "dist", "sfe"), { recursive: true });
	copyFileSync(sfeSrc, sfeDst);
	console.log("[copy-models] copied sfe/model.ftz");
} else {
	console.warn(`[copy-models] missing: ${sfeSrc} — skipping`);
}

console.log(`[copy-models] done (${copied} model dir(s) + sfe).`);
