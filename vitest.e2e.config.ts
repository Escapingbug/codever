import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['e2e/**/*.test.ts'],
        globals: true,
        testTimeout: 20_000,
        hookTimeout: 20_000,
        fileParallelism: false,
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
})
