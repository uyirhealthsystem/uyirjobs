import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development the React app runs on Vite (http://localhost:5173) and proxies /api to the
// Express server (PORT from the repository's .env), so cookies stay same-origin.
// In production Express serves the built files from web/dist.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');
  const api = `http://localhost:${env.PORT || 3000}`;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': api, '/healthz': api },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 800,
    },
  };
});
