import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseNotesFileSchema } from '../releaseNotes.js';

const DIR = new URL('../../../../release-notes/', import.meta.url);
const files = readdirSync(DIR).filter((name) => name.endsWith('.json'));

describe('release-notes files', () => {
  it('includes the backfilled releases', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(files)('%s parses and matches its filename', (name) => {
    const parsed = releaseNotesFileSchema.parse(
      JSON.parse(readFileSync(new URL(name, DIR), 'utf8'))
    );
    expect(`${parsed.version}.json`).toBe(name);
  });
});
