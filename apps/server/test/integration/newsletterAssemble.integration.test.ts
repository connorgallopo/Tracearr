/**
 * The window query decides inclusion by first_seen_at with created_at as the fallback,
 * excludes removed rows, and honors server and library scope. Only Postgres can prove it.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- newsletterAssemble
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { seedBasicOwner } from '@tracearr/test-utils';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import { loadWindowItems } from '../../src/services/newsletters/assemble.js';

const START = new Date('2026-08-26T00:00:00Z');
const END = new Date('2026-09-02T00:00:00Z');
const inside = new Date('2026-08-30T00:00:00Z');
const before = new Date('2026-08-01T00:00:00Z');

describe('loadWindowItems', () => {
  let serverId: string;

  // The suite-wide beforeEach truncates every table before each test, so this
  // seed has to be re-inserted per test rather than once in a beforeAll.
  beforeEach(async () => {
    const seeded = await seedBasicOwner();
    serverId = seeded.serverId;
    await db.insert(libraryItems).values([
      {
        serverId,
        libraryId: '1',
        ratingKey: 'a',
        title: 'Seen inside, added before',
        mediaType: 'movie',
        createdAt: before,
        firstSeenAt: inside,
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: 'b',
        title: 'Added inside, never first-seen',
        mediaType: 'movie',
        createdAt: inside,
        firstSeenAt: null,
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: 'c',
        title: 'Removed',
        mediaType: 'movie',
        createdAt: inside,
        firstSeenAt: inside,
        removedAt: inside,
      },
      {
        serverId,
        libraryId: '2',
        ratingKey: 'd',
        title: 'Other library',
        mediaType: 'movie',
        createdAt: inside,
        firstSeenAt: inside,
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: 'e',
        title: 'Before window',
        mediaType: 'movie',
        createdAt: before,
        firstSeenAt: before,
      },
      {
        serverId,
        libraryId: '1',
        ratingKey: 'f',
        title: 'At the end boundary',
        mediaType: 'movie',
        createdAt: END,
        firstSeenAt: END,
      },
    ]);
  });

  it('includes first-seen-inside and added-inside rows, excludes removed, out-of-window, and end-boundary rows', async () => {
    const rows = await loadWindowItems(
      { serverIds: [], libraryIds: [] },
      { start: START, end: END }
    );
    expect(rows.map((r) => r.ratingKey).sort()).toEqual(['a', 'b', 'd']);
    expect(rows.find((r) => r.ratingKey === 'a')?.addedAt).toEqual(before);
  });

  it('applies server and library scope', async () => {
    const scoped = await loadWindowItems(
      { serverIds: [serverId], libraryIds: ['2'] },
      { start: START, end: END }
    );
    expect(scoped.map((r) => r.ratingKey)).toEqual(['d']);
    const other = await loadWindowItems(
      { serverIds: ['00000000-0000-4000-8000-000000000000'], libraryIds: [] },
      { start: START, end: END }
    );
    expect(other).toEqual([]);
  });
});
