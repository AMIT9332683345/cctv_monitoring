import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.BACKEND_DEV_URL || 'http://127.0.0.1:8787';
const gateway = process.env.GATEWAY_DEV_URL || 'http://127.0.0.1:8089';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend },
      '/gapi': { target: gateway },
      '/media': { target: gateway },
      '/stream': { target: gateway },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: { hls: ['hls.js'] },
      },
    },
  },
});
