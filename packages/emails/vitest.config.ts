import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Without this the compiled copies under dist/ run too, so a stale build can pass.
    exclude: ['**/dist/**', '**/node_modules/**'],
  },
});
