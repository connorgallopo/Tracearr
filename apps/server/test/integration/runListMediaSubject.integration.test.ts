/**
 * Run list, media subjects
 *
 * A media run names its library item inside the subject key, and the list reads the
 * id back out with substring(). Postgres picks the offset or the regex form of that
 * function from the type it gives the bound parameter, so only a real database can
 * say which one the query gets.
 *
 * Run with: pnpm --filter @tracearr/server test:integration runListMediaSubject
 */

import { describe, it, expect } from 'vitest';
import { createTestAutomation, createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { automationRuns, libraryItems } from '../../src/db/schema.js';
import { buildRunSummaryQuery, countRuns, mapRunSummary } from '../../src/routes/runs.js';

describe('run list', () => {
  it('names the library item a media run is about', async () => {
    const server = await createTestServer();
    const automation = await createTestAutomation();
    // Read as a regex, the offset 7 matches the first 7 in the key, so the id needs one.
    const itemId = '7a1c7e52-0b77-4d8e-9f37-6c2a7b9d4e17';
    await db.insert(libraryItems).values({
      id: itemId,
      serverId: server.id,
      libraryId: 'lib-1',
      ratingKey: 'rk-1',
      title: 'Heat',
      mediaType: 'movie',
    });
    await db.insert(automationRuns).values({
      automationId: automation.id,
      serverId: server.id,
      subjectKey: `media:${itemId}`,
      data: {},
    });

    const rows = await buildRunSummaryQuery({
      where: undefined,
      orderBy: 'startedAt',
      orderDir: undefined,
      pageSize: 50,
      offset: 0,
    });

    expect(rows.map((row) => mapRunSummary(row).subject)).toEqual([
      expect.objectContaining({ kind: 'media', name: 'Heat', mediaType: 'movie' }),
    ]);
    expect(await countRuns(undefined)).toBe(1);
  });
});
