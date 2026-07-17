import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/main.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    splitting: false,
    noExternal: ['@codever/protocol', '@codever/secure-channel'],
})
