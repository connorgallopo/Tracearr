import { readFileSync, readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from '@tracearr/test-utils/db';
import { db } from '../client.js';

const MIGRATIONS = `${import.meta.dirname}/../migrations`;

function migrationSql(): string {
  const file = readdirSync(MIGRATIONS).find((name) => /^0099_.*\.sql$/.test(name));
  if (!file) throw new Error('migration 0099 not found');
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

async function revertToTextColumns(): Promise<void> {
  await db.execute(
    sql`ALTER TABLE newsletters DROP COLUMN IF EXISTS sender_name, DROP COLUMN IF EXISTS links`
  );
  await db.execute(
    sql`ALTER TABLE newsletters ALTER COLUMN intro TYPE text USING NULL, ALTER COLUMN outro TYPE text USING NULL`
  );
}

async function insertLegacy(
  name: string,
  intro: string | null,
  outro: string | null,
  recipients: string
): Promise<void> {
  await db.execute(sql`
    INSERT INTO newsletters (name, schedule, timezone, "window", scope, sections, subject, intro, outro, recipients)
    VALUES (
      ${name},
      '{"kind":"daily","time":"08:00"}',
      'UTC',
      '{"kind":"fixed","days":7}',
      '{"serverIds":[],"libraries":[]}',
      '{"movies":{"enabled":true,"max":12},"shows":{"enabled":true,"max":12,"maxSeasonsPerShow":8},"music":{"enabled":true,"max":8},"mostWatched":{"enabled":false,"max":10}}',
      's',
      ${intro},
      ${outro},
      ${recipients}::jsonb
    )
  `);
}

interface Row {
  name: string;
  intro: unknown;
  outro: unknown;
  recipients: unknown;
  sender_name: string | null;
  links: unknown;
}

async function rows(): Promise<Row[]> {
  const result = await db.execute(
    sql`SELECT name, intro, outro, recipients, sender_name, links FROM newsletters ORDER BY name`
  );
  return result.rows as unknown as Row[];
}

describe('migration 0099', () => {
  // The suite-wide reset leaves newsletters in place, and this test asserts the whole table.
  beforeEach(async () => {
    await resetTestDb();
    await db.execute(sql`DELETE FROM newsletters`);
  });

  // A failed assertion above must not leave the shared database on text columns.
  afterEach(async () => {
    await apply();
  });

  it('converts text copy to one-paragraph documents, nulls blanks, backfills excluded members, and re-runs', async () => {
    await revertToTextColumns();
    await insertLegacy('Legacy', '  Hello there  ', '', '{"members":true,"extraAddresses":[]}');
    await insertLegacy(
      'Already',
      null,
      null,
      '{"members":false,"extraAddresses":[{"address":"a@x.com"}],"excludeUserIds":["11111111-1111-4111-8111-111111111111"]}'
    );

    await apply();
    const converted = await rows();
    expect(converted).toEqual([
      {
        name: 'Already',
        intro: null,
        outro: null,
        recipients: {
          members: false,
          extraAddresses: [{ address: 'a@x.com' }],
          excludeUserIds: ['11111111-1111-4111-8111-111111111111'],
        },
        sender_name: null,
        links: { tracearr: false },
      },
      {
        name: 'Legacy',
        intro: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] }],
        },
        outro: null,
        recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
        sender_name: null,
        links: { tracearr: false },
      },
    ]);

    await apply();
    expect(await rows()).toEqual(converted);
  });
});
