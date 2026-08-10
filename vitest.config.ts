import { configDefaults, defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        // WebCrypto and durable-outbox tests are CPU/file-system intensive.
        // Letting Vitest mirror a high logical-core count oversubscribes those
        // shared resources and can starve timeout-driven reliability tests.
        maxWorkers: 4,
        exclude: [
            ...configDefaults.exclude,
            '.worktrees/**',
            'apps/pwa/tests/**',
            // Optional extensions have independent packages and test commands.
            'extensions/**',
            'e2e/**',
        ],
        globals: true,
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src'),
        },
    },
})
