/**
 * Routes Tests Configuration
 *
 * API endpoint tests with mocked database:
 * - routes/__tests__/* (rules, violations)
 * - routes/auth/__tests__/* (auth utilities)
 * - routes/stats/__tests__/* (stats utilities)
 *
 * Run: pnpm test:routes
 */

import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      name: 'routes',
      include: [
        'src/routes/__tests__/*.test.ts',
        'src/routes/auth/__tests__/*.test.ts',
        'src/routes/stats/__tests__/*.test.ts',
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'json-summary'],
        reportsDirectory: './coverage/routes',
        include: ['src/routes/**/*.ts'],
        exclude: ['**/*.test.ts', '**/*.security.test.ts', '**/test/**'],
      },
    },
  })
);
