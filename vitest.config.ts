import { configDefaults, defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
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
