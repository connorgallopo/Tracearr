import { readFileSync, readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from '@tracearr/test-utils/db';
import { db } from '../client.js';
import { servers } from '../schema.js';
import { loadServerLinks } from '../../services/newsletters/store.js';

const MIGRATIONS = `${import.meta.dirname}/../migrations`;

function migrationSql(): string {
  const file = readdirSync(MIGRATIONS).find((name) => /^0101_.*\.sql$/.test(name));
  if (!file) throw new Error('migration 0101 not found');
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

async function publicUrlColumn(): Promise<{ data_type: string; is_nullable: string } | undefined> {
  const result = await db.execute(sql`
    SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'servers' AND column_name = 'public_url'
  `);
  return (result.rows as unknown as { data_type: string; is_nullable: string }[])[0];
}

describe('migration 0101', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it('adds a nullable text public_url that the newsletter server links read back', async () => {
    await db.execute(sql`ALTER TABLE servers DROP COLUMN IF EXISTS public_url`);
    expect(await publicUrlColumn()).toBeUndefined();

    await apply();
    expect(await publicUrlColumn()).toEqual({ data_type: 'text', is_nullable: 'YES' });

    const rows = await db
      .insert(servers)
      .values([
        {
          name: 'Attic',
          type: 'jellyfin',
          url: 'http://192.168.1.20:8096',
          token: 'tok',
          publicUrl: 'https://jellyfin.example.com',
        },
        { name: 'Basement', type: 'plex', url: 'http://192.168.1.10:32400', token: 'tok' },
      ])
      .returning({ id: servers.id });
    const links = await loadServerLinks(rows.map((r) => r.id));
    expect(links.map((l) => [l.name, l.publicUrl])).toEqual([
      ['Attic', 'https://jellyfin.example.com'],
      ['Basement', null],
    ]);
  });
});
