import { defineConfig } from 'tsup'
import path from 'path'

export default defineConfig({
    entry: ['src/index.ts', 'src/daemon.ts', 'src/matrix-daemon.ts', 'src/mcp/stdio.ts'],
  format: ['esm'],
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  noExternal: ['@codever/protocol', '@codever/security'],
  esbuildOptions(options) {
    options.alias = {
      '@': path.resolve('./src')
    }
  }
})
