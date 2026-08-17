import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Overridable so multiple dev sessions can each point at their own backend
// instance without editing this shared file; defaults preserve prior behavior.
const API_PROXY = process.env.BBP_API_PROXY || 'http://localhost:8002'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/health':  API_PROXY,
      '/analyze': API_PROXY,
      '/rank':    API_PROXY,
      '/auth':    API_PROXY,
      '/drive':   API_PROXY,
      '/edit':    API_PROXY,
      '/sessions': {
        target: API_PROXY,
        bypass(req) {
          if (req.method === 'GET' && req.headers.accept?.includes('text/html')) return req.url
        },
      },
      '/runs':    API_PROXY,
      '/photos':  API_PROXY,
      '/settings': API_PROXY,
      '/gallery/api': API_PROXY,
      '/google':  API_PROXY,
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