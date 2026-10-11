import { defineConfig } from 'tsdown';

export default defineConfig(async () => {
    const { default: getExePath } = await import(new URL('lib/getExePath.js', import.meta.resolve('typescript/package.json')).href);

    return {
        entry: { index: 'src/index.ts' },
        format: ['esm', 'cjs'],
        minify: true,
        dts: { tsgo: { path: getExePath() } },
        outputOptions: {
            keepNames: true,
        },
    };
});
