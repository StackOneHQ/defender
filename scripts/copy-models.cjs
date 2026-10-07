#!/usr/bin/env node
/**
 * Mirror bundled model assets from src/ to dist/ after a build.
 *
 * Add new model directories to MODEL_DIRS — each is copied recursively from
 * src/classifiers/models/<name> → dist/models/<name>. Tier 2 callers resolve
 * models via paths relative to the compiled file (which lives at dist/).
 */
const { cpSync, mkdirSync, existsSync, copyFileSync, openSync, readSync, closeSync, statSync, readdirSync } = require("node:fs");
const { resolve, extname } = require("node:path");

const ROOT = resolve(__dirname, "..");

// Models are tracked with Git LFS. A build from a checkout without `git lfs pull` leaves ~130-byte
// pointers in place of the real binaries; copying those would publish a broken package with no error.
// Guard the output so the build FAILS loudly instead (covers manual publishes + any CI regression
// that drops `lfs: true`).
const LFS_POINTER_MAGIC = "version https://git-lfs.github.com/spec/v1";
const MIN_MODEL_BYTES = { ".onnx": 1_000_000, ".ftz": 100_000 };

function assertRealModel(file) {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(LFS_POINTER_MAGIC.length);
		const n = readSync(fd, buf, 0, buf.length, 0);
		if (n >= LFS_POINTER_MAGIC.length && buf.toString("utf8") === LFS_POINTER_MAGIC) {
			throw new Error(`${file} is a Git LFS pointer, not the model — run \`git lfs pull\` before building/publishing.`);
		}
	} finally {
		closeSync(fd);
	}
	const min = MIN_MODEL_BYTES[extname(file)] ?? 0;
	const size = statSync(file).size;
	if (size < min) {
		throw new Error(`${file} is ${size} bytes (< ${min}) — model looks truncated/unmaterialized; run \`git lfs pull\`.`);
	}
}

function validateModelsUnder(dir) {
	for (const entry of readdirSync(dir, { recursive: true })) {
		const name = entry.toString();
		if (name.endsWith(".onnx") || name.endsWith(".ftz")) assertRealModel(resolve(dir, name));
	}
}

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
		throw new Error(`[copy-models] missing model source: ${src}`);
	}
	mkdirSync(dst, { recursive: true });
	cpSync(src, dst, { recursive: true });
	validateModelsUnder(dst); // fail the build on a pointer/truncated binary rather than ship it
	console.log(`[copy-models] copied ${name}`);
	copied++;
}

/** SFE FastText model (single file). */
const sfeSrc = resolve(ROOT, "src", "sfe", "model.ftz");
const sfeDst = resolve(ROOT, "dist", "sfe", "model.ftz");
if (existsSync(sfeSrc)) {
	mkdirSync(resolve(ROOT, "dist", "sfe"), { recursive: true });
	copyFileSync(sfeSrc, sfeDst);
	assertRealModel(sfeDst);
	console.log("[copy-models] copied sfe/model.ftz");
} else {
	throw new Error(`[copy-models] missing model source: ${sfeSrc}`);
}

console.log(`[copy-models] done (${copied} model dir(s) + sfe).`);
