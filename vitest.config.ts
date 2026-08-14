import { configDefaults, defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        exclude: [
            ...configDefaults.exclude,
            '.worktrees/**',
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
