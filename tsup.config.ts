import { defineConfig } from 'tsup';

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
});
