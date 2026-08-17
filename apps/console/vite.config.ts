import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The console talks to the API on the same origin in production, so the dev
// server proxies /api through to it rather than the app knowing two base URLs.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
