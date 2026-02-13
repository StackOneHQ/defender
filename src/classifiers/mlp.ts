/**
 * MLP forward pass for prompt injection classification.
 *
 * Architecture: 384 (embedding dim) -> 256 -> 128 -> 1 (logits)
 * Activation: ReLU between hidden layers
 * Output: Sigmoid applied to logits for probability in [0, 1]
 *
 * Weights are exported from Python via classifier-eval/scripts/export_mlp_weights.py
 */

/**
 * MLP weights structure exported from PyTorch
 */
export interface MLPWeights {
  config: {
    dim?: number;
    hidden?: number[];
    embedding_model_id?: string;
  };
  state_dict: {
    'net.0.weight': number[][];
    'net.0.bias': number[];
    'net.3.weight': number[][];
    'net.3.bias': number[];
    'net.6.weight': number[][];
    'net.6.bias': number[];
  };
}

/**
 * Loaded MLP model ready for inference
 */
export interface MLPModel {
  /** First layer weights (256 x 384) */
  w0: number[][];
  /** First layer bias (256) */
  b0: number[];
  /** Second layer weights (128 x 256) */
  w1: number[][];
  /** Second layer bias (128) */
  b1: number[];
  /** Output layer weights (1 x 128) */
  w2: number[][];
  /** Output layer bias (1) */
  b2: number[];
  /** Expected embedding dimension */
  embeddingDim: number;
}

// Matrix-vector multiplication: (M x N) @ (N,) -> (M,)
function matVecMul(matrix: number[][], vec: number[]): number[] {
  const out: number[] = new Array(matrix.length);
  for (let i = 0; i < matrix.length; i++) {
    let sum = 0;
    const row = matrix[i]!;
    for (let j = 0; j < vec.length; j++) {
      sum += row[j]! * vec[j]!;
    }
    out[i] = sum;
  }
  return out;
}

// Add bias vector elementwise
function addBias(vec: number[], bias: number[]): number[] {
  const out: number[] = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i]! + bias[i]!;
  }
  return out;
}

// ReLU activation
function relu(vec: number[]): number[] {
  const out: number[] = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = vec[i]! > 0 ? vec[i]! : 0;
  }
  return out;
}

// Sigmoid activation
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Validate and load MLP weights from exported JSON
 *
 * @param json - Exported weights from export_mlp_weights.py
 * @returns Loaded model ready for inference
 * @throws Error if weights are invalid or missing required keys
 */
export function loadMLPWeights(json: MLPWeights): MLPModel {
  const d = json.state_dict;

  // Validate required keys
  const requiredKeys = [
    'net.0.weight',
    'net.0.bias',
    'net.3.weight',
    'net.3.bias',
    'net.6.weight',
    'net.6.bias',
  ] as const;

  for (const key of requiredKeys) {
    if (!d[key]) {
      throw new Error(`MLP weights missing required key: ${key}`);
    }
  }

  const w0 = d['net.0.weight'];
  const b0 = d['net.0.bias'];
  const w1 = d['net.3.weight'];
  const b1 = d['net.3.bias'];
  const w2 = d['net.6.weight'];
  const b2 = d['net.6.bias'];

  // Infer embedding dimension from first layer weights
  const embeddingDim = w0[0]?.length ?? 384;

  // Validate dimensions
  if (w0.length !== 256 || b0.length !== 256) {
    throw new Error(`Invalid layer 0 dimensions: expected (256, ${embeddingDim}), got (${w0.length}, ${w0[0]?.length})`);
  }
  if (w1.length !== 128 || b1.length !== 128) {
    throw new Error(`Invalid layer 1 dimensions: expected (128, 256), got (${w1.length}, ${w1[0]?.length})`);
  }
  if (w2.length !== 1 || b2.length !== 1) {
    throw new Error(`Invalid output layer dimensions: expected (1, 128), got (${w2.length}, ${w2[0]?.length})`);
  }

  return { w0, b0, w1, b1, w2, b2, embeddingDim };
}

/**
 * Run MLP forward pass on a single embedding vector
 *
 * @param model - Loaded MLP model
 * @param embedding - Input embedding vector (384-dim by default)
 * @returns Probability in [0, 1] where higher = more likely prompt injection
 * @throws Error if embedding dimension doesn't match model
 */
export function mlpForward(model: MLPModel, embedding: number[]): number {
  if (embedding.length !== model.embeddingDim) {
    throw new Error(
      `Embedding dimension mismatch: expected ${model.embeddingDim}, got ${embedding.length}`
    );
  }

  // Layer 0: Linear + ReLU
  let h = addBias(matVecMul(model.w0, embedding), model.b0);
  h = relu(h);

  // Layer 1: Linear + ReLU
  h = addBias(matVecMul(model.w1, h), model.b1);
  h = relu(h);

  // Output: Linear + Sigmoid
  const logit = addBias(matVecMul(model.w2, h), model.b2)[0]!;
  return sigmoid(logit);
}

/**
 * Run MLP forward pass on a batch of embeddings
 *
 * @param model - Loaded MLP model
 * @param embeddings - Array of embedding vectors
 * @returns Array of probabilities
 */
export function mlpForwardBatch(model: MLPModel, embeddings: number[][]): number[] {
  return embeddings.map((emb) => mlpForward(model, emb));
}
