import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
