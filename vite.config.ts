import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  // GitHub Pages serves the site from /<repo>/, so the base path is
  // configurable. Local development and any root-hosted deploy use '/'.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@server': fileURLToPath(new URL('./server', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET.replace('http', 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
