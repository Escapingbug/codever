import { defineConfig } from 'tsup'
import path from 'path'

export default defineConfig({
    entry: ['src/index.ts', 'src/mcp/stdio.ts'],
  format: ['esm'],
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: ['@codever/execution-auth', '@codever/protocol'],
  esbuildOptions(options) {
    options.alias = {
      '@': path.resolve('./src')
    }
  }
})
