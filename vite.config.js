import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

function getBackendPort() {
  try {
    const envPath = path.resolve(__dirname, 'server/.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^PORT\s*=\s*(\d+)/m);
      if (match) return Number(match[1]);
    }
  } catch (e) {}
  return 5000;
}

const backendPort = getBackendPort();

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    // The browser calls /api/... on the Vite origin; Vite forwards it to the Express server.
    proxy: {
      '/api': { target: `http://localhost:${backendPort}`, changeOrigin: true }
    }
  }
});
