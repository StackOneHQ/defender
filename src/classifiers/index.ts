/**
 * Classification modules for prompt injection detection
 *
 * Tier 1: Pattern-based detection (fast, regex)
 * Tier 2: MLP-based detection (accurate, requires embeddings)
 */

// Tier 1: Pattern detection
export * from './patterns';
export * from './pattern-detector';

// Tier 2: MLP classifier
export * from './mlp';
export * from './embedder';
export * from './tier2-classifier';
export * from './weights';

// Tier 2: ONNX classifier (fine-tuned MiniLM)
export * from './onnx-classifier';
