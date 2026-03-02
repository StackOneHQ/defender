import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    minify: true,
    dts: true,
    outputOptions: {
        keepNames: true,
    },
});
