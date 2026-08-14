import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// The Flask app serves the built SPA out of public/app, so the whole thing
// stays behind the existing gunicorn process — no second service to deploy.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/app/',
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: path.resolve(__dirname, '../public/app'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Dev server talks to the local Flask instance so the 126 existing
    // endpoints work without CORS juggling.
    proxy: {
      '/api': { target: 'http://localhost:5001', changeOrigin: true },
    },
  },
})
