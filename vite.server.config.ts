import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: path.resolve(import.meta.dirname, 'src/server/index.ts'),
    outDir: path.resolve(import.meta.dirname, 'dist/server'),
    emptyOutDir: true,
    target: 'node22',
    sourcemap: false,
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
      },
    },
  },
});
