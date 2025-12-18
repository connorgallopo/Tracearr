/**
 * Unit Tests Configuration
 *
 * Fast, isolated tests for pure functions:
 * - utils/* (crypto, jwt, password, parsing, http, errors)
 * - schemas (Zod validation)
 * - mediaServer parsers (Plex/Jellyfin response parsing)
 *
 * Run: pnpm test:unit
 */

import { defineConfig, mergeConfig } from 'vitest/config';
import { sharedConfig } from './vitest.shared.js';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      name: 'unit',
      include: [
        'src/utils/__tests__/*.test.ts',
        'src/test/schemas.test.ts',
        'src/services/mediaServer/__tests__/*.test.ts',
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'json-summary'],
        reportsDirectory: './coverage/unit',
        include: ['src/utils/**/*.ts', 'src/services/mediaServer/**/*.ts'],
        exclude: ['**/*.test.ts', '**/test/**'],
      },
    },
  })
);
