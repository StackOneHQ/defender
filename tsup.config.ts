import { defineConfig } from 'tsup';
import { cpSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  // Bundle the JSON weights file into the output
  loader: {
    '.json': 'json',
  },
  // Don't externalize the weights JSON
  noExternal: [/mlp_weights\.json/],
  onSuccess: async () => {
    // Copy ONNX model files to dist/models/ so they're bundled in the package
    const modelSrc = resolve('src', 'classifiers', 'models', 'minilm-full-aug');
    const modelDest = resolve('dist', 'models', 'minilm-full-aug');

    if (existsSync(modelSrc)) {
      mkdirSync(modelDest, { recursive: true });
      cpSync(modelSrc, modelDest, { recursive: true });
      console.log('Copied ONNX model files to dist/models/minilm-full-aug/');
    } else {
      console.warn(
        'ONNX model files not found at src/classifiers/models/minilm-full-aug/. ' +
        'ONNX mode will not work until model files are added.'
      );
    }
  },
});
