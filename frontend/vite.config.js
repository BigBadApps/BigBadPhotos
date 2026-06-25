import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/health':  'http://localhost:8002',
      '/analyze': 'http://localhost:8002',
      '/rank':    'http://localhost:8002',
      '/auth':    'http://localhost:8002',
      '/drive':   'http://localhost:8002',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  optimizeDeps: {
    include: ['zustand', 'use-sync-external-store/shim/with-selector'],
  },
})