import { readFileSync, readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from '@tracearr/test-utils/db';
import { db } from '../client.js';
import { libraries, servers } from '../schema.js';

const MIGRATIONS = `${import.meta.dirname}/../migrations`;

function migrationSql(): string {
  const file = readdirSync(MIGRATIONS).find((name) => /^0100_.*\.sql$/.test(name));
  if (!file) throw new Error('migration 0100 not found');
  return readFileSync(`${MIGRATIONS}/${file}`, 'utf8');
}

/** Mirrors how drizzle applies a breakpoints file: one execute per statement. */
async function apply(): Promise<void> {
  const statements = migrationSql()
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await db.execute(sql.raw(statement));
}

async function insertNewsletter(name: string, scope: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO newsletters (name, schedule, timezone, "window", scope, sections, subject, recipients)
    VALUES (
      ${name},
      '{"kind":"daily","time":"08:00"}',
      'UTC',
      '{"kind":"fixed","days":7}',
      ${scope}::jsonb,
      '{"movies":{"enabled":true,"max":12},"shows":{"enabled":true,"max":12,"maxSeasonsPerShow":8},"music":{"enabled":true,"max":8},"mostWatched":{"enabled":false,"max":10}}',
      's',
      '{"members":true,"extraAddresses":[],"excludeUserIds":[]}'
    )
  `);
}

async function scopes(): Promise<Record<string, unknown>> {
  const result = await db.execute(sql`SELECT name, scope FROM newsletters ORDER BY name`);
  return Object.fromEntries(
    (result.rows as unknown as { name: string; scope: unknown }[]).map((r) => [r.name, r.scope])
  );
}

describe('migration 0100', () => {
  let basement: string;
  let attic: string;

  // The suite-wide reset leaves newsletters in place, and this test asserts the whole table.
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM newsletters`);
    const rows = await db
      .insert(servers)
      .values([
        { name: 'Basement', type: 'plex', url: 'http://basement:32400', token: 'tok' },
        { name: 'Attic', type: 'plex', url: 'http://attic:32400', token: 'tok' },
      ])
      .returning({ id: servers.id, name: servers.name });
    basement = rows.find((r) => r.name === 'Basement')!.id;
    attic = rows.find((r) => r.name === 'Attic')!.id;
    await db.insert(libraries).values([
      { serverId: basement, libraryId: '1', name: 'Movies', mediaType: 'movie' },
      { serverId: attic, libraryId: '1', name: 'Anime', mediaType: 'show' },
      { serverId: attic, libraryId: '7', name: 'Music', mediaType: 'music' },
    ]);
  });

  it('pairs bare ids with every scoped server that has the library, drops unmatched ids, and re-runs as a no-op', async () => {
    await insertNewsletter('Everywhere', '{"serverIds":[],"libraryIds":["1","9"]}');
    await insertNewsletter('Attic only', `{"serverIds":["${attic}"],"libraryIds":["1","7"]}`);
    await insertNewsletter('Nothing chosen', '{"serverIds":[],"libraryIds":[]}');
    await insertNewsletter(
      'Already paired',
      `{"serverIds":[],"libraries":[{"serverId":"${basement}","libraryId":"1"}]}`
    );

    await apply();
    const converted = await scopes();
    expect(converted).toEqual({
      Everywhere: {
        serverIds: [],
        libraries: [basement, attic].sort().map((serverId) => ({ serverId, libraryId: '1' })),
      },
      'Attic only': {
        serverIds: [attic],
        libraries: [
          { serverId: attic, libraryId: '1' },
          { serverId: attic, libraryId: '7' },
        ],
      },
      'Nothing chosen': { serverIds: [], libraries: [] },
      'Already paired': { serverIds: [], libraries: [{ serverId: basement, libraryId: '1' }] },
    });

    await apply();
    expect(await scopes()).toEqual(converted);
  });
});
