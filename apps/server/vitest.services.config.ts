/**
 * Services Tests Configuration
 *
 * Business logic and background job tests:
 * - services/* (rules, cache, geoip, userService, tautulli)
 * - jobs/* (aggregator, poller logic)
 *
 * May use mocks for external dependencies.
 *
 * Run: pnpm test:services
 */

import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      name: 'services',
      include: [
        'src/services/__tests__/*.test.ts',
        'src/jobs/__tests__/*.test.ts',
        'src/jobs/poller/__tests__/*.test.ts',
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'json-summary'],
        reportsDirectory: './coverage/services',
        include: ['src/services/**/*.ts', 'src/jobs/**/*.ts'],
        exclude: [
          '**/*.test.ts',
          '**/test/**',
          'src/services/mediaServer/**/*.ts', // Covered by unit tests
        ],
      },
    },
  })
);
