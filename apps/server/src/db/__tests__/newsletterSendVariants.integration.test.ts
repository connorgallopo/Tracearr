import { readFileSync, readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb } from '@tracearr/test-utils/db';
import { db } from '../client.js';
import { servers } from '../schema.js';

const MIGRATIONS = `${import.meta.dirname}/../migrations`;

function statementsOf(): string[] {
  const file = readdirSync(MIGRATIONS).find((name) => /^0102_.*\.sql$/.test(name));
  if (!file) throw new Error('migration 0102 not found');
  return readFileSync(`${MIGRATIONS}/${file}`, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Mirrors how drizzle applies a breakpoints file: one execute per statement. */
async function apply(statements: string[]): Promise<void> {
  for (const statement of statements) await db.execute(sql.raw(statement));
}

async function hasSnapshotTable(): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT 1 FROM information_schema.tables WHERE table_name = 'newsletter_send_snapshots'`
  );
  return result.rows.length > 0;
}

/** The shape 0101 left behind: the rendered columns on the send, no variants, no snapshot table. */
async function rewindTo0101(): Promise<void> {
  await db.execute(sql`DROP TABLE IF EXISTS newsletter_send_snapshots`);
  await db.execute(sql`ALTER TABLE newsletter_sends DROP COLUMN IF EXISTS variants`);
  await db.execute(sql`ALTER TABLE newsletter_send_recipients DROP COLUMN IF EXISTS variant_key`);
  await db.execute(sql`
    ALTER TABLE newsletter_sends
      ADD COLUMN view_token text NOT NULL DEFAULT '',
      ADD COLUMN subject text NOT NULL DEFAULT '',
      ADD COLUMN html text,
      ADD COLUMN text text,
      ADD COLUMN posters jsonb NOT NULL DEFAULT '{}'::jsonb
  `);
  await db.execute(
    sql`ALTER TABLE newsletter_sends ADD CONSTRAINT newsletter_sends_view_token_unique UNIQUE (view_token)`
  );
}

async function insertNewsletter(name: string, scope: string): Promise<string> {
  const result = await db.execute(sql`
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
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
}

async function insertOldSend(
  newsletterId: string,
  over: { token: string; html: string | null; outcome: string; recipientCount: number }
): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO newsletter_sends (newsletter_id, view_token, trigger, window_start, window_end, outcome,
                                  recipient_count, subject, html, text, posters, finished_at)
    VALUES (${newsletterId}, ${over.token}, 'schedule', '2026-08-26T00:00:00Z', '2026-09-02T00:00:00Z',
            ${over.outcome}, ${over.recipientCount}, 'Weekly digest', ${over.html},
            ${over.html === null ? null : 'plain'}, '{"m1":{"serverId":"s","thumbPath":"/t","version":"v"}}'::jsonb, now())
    RETURNING id
  `);
  return (result.rows[0] as { id: string }).id;
}

async function insertOldRecipient(sendId: string, address: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO newsletter_send_recipients (send_id, address, status) VALUES (${sendId}, ${address}, 'sent')`
  );
}

describe('migration 0102', () => {
  let basement: string;
  let attic: string;

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
  });

  it('gives every send one union variant from its scope, keys its recipients and copied snapshot by it, and drops the rendered columns', async () => {
    const statements = statementsOf();
    let rendered = '';
    let pruned = '';
    let skipped = '';
    await rewindTo0101();
    try {
      const everywhere = await insertNewsletter('Everywhere', '{"serverIds":[],"libraries":[]}');
      const atticOnly = await insertNewsletter(
        'Attic only',
        `{"serverIds":["${attic}"],"libraries":[]}`
      );
      rendered = await insertOldSend(everywhere, {
        token: 't-rendered',
        html: '<p>hi</p>',
        outcome: 'sent',
        recipientCount: 2,
      });
      pruned = await insertOldSend(atticOnly, {
        token: 't-pruned',
        html: null,
        outcome: 'partial',
        recipientCount: 1,
      });
      skipped = await insertOldSend(everywhere, {
        token: 't-skipped',
        html: null,
        outcome: 'skipped_empty',
        recipientCount: 0,
      });
      await insertOldRecipient(rendered, 'a@x.com');
      await insertOldRecipient(rendered, 'b@x.com');
      await insertOldRecipient(pruned, 'c@x.com');
      await apply(statements);
    } finally {
      // Other integration files in this worker share the DB, so a throw above must not leave the 0101 shape behind.
      if (!(await hasSnapshotTable())) await apply(statements);
    }

    const [first, second] = [attic, basement].sort();
    const unionKey = `${first},${second}`;
    const names = [first, second].map((id) => (id === attic ? 'Attic' : 'Basement'));
    const zero = { movies: 0, shows: 0, albums: 0, mostWatched: 0 };
    const sends = await db.execute(sql`SELECT id, variants FROM newsletter_sends`);
    const variantsOf = Object.fromEntries(
      (sends.rows as unknown as { id: string; variants: unknown }[]).map((r) => [r.id, r.variants])
    );
    expect(variantsOf[rendered]).toEqual([
      {
        key: unionKey,
        serverIds: [first, second],
        serverNames: names,
        recipientCount: 2,
        trimmed: zero,
        bytes: 9,
        empty: false,
      },
    ]);
    expect(variantsOf[pruned]).toEqual([
      {
        key: attic,
        serverIds: [attic],
        serverNames: ['Attic'],
        recipientCount: 1,
        trimmed: zero,
        bytes: 0,
        empty: false,
      },
    ]);
    expect(variantsOf[skipped]).toEqual([
      {
        key: unionKey,
        serverIds: [first, second],
        serverNames: names,
        recipientCount: 0,
        trimmed: zero,
        bytes: 0,
        empty: true,
      },
    ]);

    const recipients = await db.execute(
      sql`SELECT send_id, address, variant_key FROM newsletter_send_recipients ORDER BY address`
    );
    expect(recipients.rows).toEqual([
      { send_id: rendered, address: 'a@x.com', variant_key: unionKey },
      { send_id: rendered, address: 'b@x.com', variant_key: unionKey },
      { send_id: pruned, address: 'c@x.com', variant_key: attic },
    ]);

    const snapshots = await db.execute(
      sql`SELECT send_id, variant_key, view_token, subject, html, text, posters FROM newsletter_send_snapshots`
    );
    expect(snapshots.rows).toEqual([
      {
        send_id: rendered,
        variant_key: unionKey,
        view_token: 't-rendered',
        subject: 'Weekly digest',
        html: '<p>hi</p>',
        text: 'plain',
        posters: { m1: { serverId: 's', thumbPath: '/t', version: 'v' } },
      },
    ]);

    const columns = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'newsletter_sends'
        AND column_name IN ('view_token', 'subject', 'html', 'text', 'posters')
    `);
    expect(columns.rows).toEqual([]);
  });
});
