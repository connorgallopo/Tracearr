/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  // Load env from project root (../../.env)
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const basePath = env.BASE_PATH || '';

  return {
    base: basePath || '/',
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        [`${basePath}/api`]: {
          target: 'http://localhost:3000',
          changeOrigin: true,
        },
        [`${basePath}/socket.io`]: {
          target: 'http://localhost:3000',
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
    test: {
      passWithNoTests: true,
    },
  };
});
