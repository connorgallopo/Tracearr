/**
 * Main Vitest Configuration
 *
 * Runs ALL tests when using `pnpm test` or `pnpm test:coverage`.
 * For targeted test runs, use the group-specific configs:
 *
 *   pnpm test:unit      - Pure functions (utils, parsers, schemas)
 *   pnpm test:services  - Business logic (services, jobs)
 *   pnpm test:routes    - API endpoints (routes with mocked DB)
 *   pnpm test:security  - Auth/authz behavior tests
 *
 * Integration tests use a separate config:
 *   pnpm test:integration - Real DB tests (vitest.integration.config.ts)
 */

import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      // Run all unit + security tests (excludes integration)
      include: ['src/**/*.test.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.integration.test.ts',
        '**/test/stress/**',
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
        reportsDirectory: './coverage',
        include: ['src/services/**/*.ts', 'src/jobs/**/*.ts', 'src/utils/**/*.ts'],
        exclude: [
          '**/*.test.ts',
          '**/test/**',
          // Type-only files with no executable code
          '**/types.ts',
          // HTTP client wrappers tested via integration tests
          '**/services/mediaServer/plex/client.ts',
          '**/services/mediaServer/plex/eventSource.ts',
          '**/services/mediaServer/jellyfin/client.ts',
          '**/services/mediaServer/emby/client.ts',
          // External I/O services better suited for integration tests
          '**/services/imageProxy.ts',
          '**/services/sseManager.ts',
          '**/services/sync.ts',
          '**/services/termination.ts',
          '**/services/plexGeoip.ts',
        ],
        thresholds: {
          statements: 42,
          branches: 35,
          functions: 53,
          lines: 42,
        },
      },
    },
  })
);
