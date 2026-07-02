/**
 * Import a module by a hard-coded specifier WITHOUT exposing it to a bundler's
 * static analysis.
 *
 * Used for OPTIONAL peer dependencies (`onnxruntime-node`,
 * `@huggingface/transformers`, `fasttext.wasm`) so that webpack / esbuild
 * consumers who never exercise those code paths don't get a build-time
 * resolution error, and Node consumers who haven't installed them fail lazily
 * (caught by the caller) rather than at import time.
 *
 * A plain `await import("onnxruntime-node")` uses a literal specifier that
 * bundlers resolve at build time. Passing the specifier as a runtime variable
 * to the real `import()` operator keeps it non-analyzable — bundlers can't
 * resolve it statically, so they leave it as a runtime import instead of
 * failing the build. The magic comments suppress webpack/Vite warnings; the
 * real `import()` (unlike `new Function("return import(spec)")`, which throws
 * "A dynamic import callback was not specified") keeps the module context so it
 * actually loads at runtime.
 *
 * Safety: every caller passes ONLY hard-coded string literals — never
 * user-controlled input.
 */
export function dynamicImport<T = unknown>(spec: string): Promise<T> {
	return import(/* webpackIgnore: true */ /* @vite-ignore */ spec) as Promise<T>;
}
