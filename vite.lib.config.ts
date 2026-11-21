import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    lib: {
      entry: fileURLToPath(new URL('./src/lib/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'agent-stream-ui.js',
      cssFileName: 'agent-stream-ui',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    },
    sourcemap: true,
  },
})
