import { describe, it, expect, vi } from 'vitest';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual.win32, default: actual.win32 };
});

import { resolveWebAsset } from '../webRoot.js';

describe('resolveWebAsset on win32', () => {
  const root = 'C:\\srv\\tracearr\\apps\\web\\dist';

  it('returns a slash-separated path for a nested asset', () => {
    expect(resolveWebAsset(root, '/assets/fonts/inter.woff2')).toBe('assets/fonts/inter.woff2');
  });

  it('returns a slash-separated path for a basemap file', () => {
    expect(resolveWebAsset(root, '/basemaps/glyphs/0-255.pbf')).toBe('basemaps/glyphs/0-255.pbf');
  });

  it('still rejects an escape from the root', () => {
    expect(resolveWebAsset(root, '/../../secret.env')).toBeNull();
  });
});
