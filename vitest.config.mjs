import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['specs/**/*.spec.ts'],
        globals: true,
        clearMocks: true,
    },
});
