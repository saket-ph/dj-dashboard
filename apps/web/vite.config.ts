import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// In development the Vite server proxies /api to the API process (default port 3000).
// In production the API serves apps/web/dist itself, so everything stays on one origin.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
