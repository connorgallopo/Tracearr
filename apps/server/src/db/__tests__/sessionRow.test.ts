import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../client.js', () => ({
  db: {},
}));

import { renderSql } from '../../test/helpers.js';
import { SERVER_SRC as SRC, lineOf, sourceFiles } from '../../test/sourceFiles.js';
import { sessionRowById, sessionRowsWhere, storedSessionRowById } from '../sessions/row.js';

const isoParams = (params: unknown[]) =>
  params.map((param) => (param instanceof Date ? param.toISOString() : param));

function expectBoundedRow(startedAt: Date | number) {
  const { sql, params } = renderSql(sessionRowById({ id: 'session-1', startedAt }));
  expect(sql).toContain('sessions.id = ');
  expect(sql).toContain('sessions.started_at >= ');
  expect(params).toContain('session-1');
  expect(isoParams(params)).toContain('2026-10-22T11:59:00.000Z');
}

describe('sessionRowById', () => {
  it("bounds the row by id and a started_at floor one minute before the caller's value", () => {
    expectBoundedRow(new Date('2026-10-22T12:00:00Z'));
  });

  it('accepts started_at as epoch milliseconds', () => {
    expectBoundedRow(Date.parse('2026-10-22T12:00:00Z'));
  });

  it('puts no ceiling on started_at', () => {
    const { sql, params } = renderSql(
      sessionRowById({ id: 'session-1', startedAt: new Date('2026-10-22T12:00:00Z') })
    );
    expect(sql).not.toContain('<=');
    expect(sql).not.toContain('between');
    expect(params).toHaveLength(2);
  });

  it('the stored variant pins started_at to a minute either side', () => {
    const { sql, params } = renderSql(
      storedSessionRowById({ id: 'session-1', startedAt: new Date('2026-10-22T12:00:00Z') })
    );
    expect(sql).toContain('sessions.id = ');
    expect(sql).toContain('sessions.started_at between ');
    expect(isoParams(params)).toEqual([
      'session-1',
      '2026-10-22T11:59:00.000Z',
      '2026-10-22T12:01:00.000Z',
    ]);
  });

  it('an empty row set matches nothing instead of binding an invalid start', () => {
    const { sql, params } = renderSql(sessionRowsWhere([]));
    expect(sql).toBe('false');
    expect(params).toEqual([]);
  });

  // inArray(sessions.id, ...) writes are out of scope here; the bulk delete in routes/sessions.ts
  // bounds its set through sessionRowsWhere.
  it('every drizzle write to sessions goes through sessionRowById or its stored variant', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles()) {
      const text = readFileSync(join(SRC, path), 'utf8');
      for (const match of text.matchAll(/\.(update|delete)\(sessions\)/g)) {
        const end = text.indexOf(';', match.index);
        const statement = text.slice(match.index, end === -1 ? undefined : end);
        if (
          statement.includes('eq(sessions.id') &&
          !/\b(sessionRowById|storedSessionRowById)\(/.test(statement)
        ) {
          offenders.push(`${path}:${lineOf(text, match.index)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the poller and SSE row lookups go through sessionRowById', () => {
    // A retry entry queued before startedAt was stored has only the id; such entries age out
    // within SESSION_WRITE_RETRY.MAX_TOTAL_ATTEMPTS ticks.
    const allowed = [{ path: 'jobs/sseProcessor.ts', text: 'eq(sessions.id, retry.sessionId)' }];
    const scoped = (path: string) =>
      path.startsWith('jobs/poller/') ||
      path === 'jobs/sseProcessor.ts' ||
      path === 'services/automations/wakes/pauseWakes.ts';

    const offenders: string[] = [];
    for (const path of sourceFiles().filter(scoped)) {
      const text = readFileSync(join(SRC, path), 'utf8');
      for (const match of text.matchAll(/eq\(sessions\.id,/g)) {
        const isAllowed = allowed.some(
          (entry) => entry.path === path && text.startsWith(entry.text, match.index)
        );
        if (!isAllowed) offenders.push(`${path}:${lineOf(text, match.index)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
