import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        include: ['e2e/**/*.test.ts'],
        testTimeout: 60_000,
        hookTimeout: 60_000,
        globals: true,
        sequence: { concurrent: false },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
            '@codever/native-bridge': resolve(__dirname, 'packages/native-bridge/src/index.ts'),
        },
    },
})
