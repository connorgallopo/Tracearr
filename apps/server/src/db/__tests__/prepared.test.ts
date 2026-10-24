/**
 * Prepared statement predicates
 *
 * The dashboard "Alerts" metric has two branches: unfiltered reads run through
 * violations_count_since, server-filtered reads through raw SQL that inner-joins
 * server_users. Both have to count the same rows, so the prepared statement has
 * to spell out the user predicate the join implies.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { renderSql } from '../../test/helpers.js';

const { preparedWheres } = vi.hoisted(() => ({ preparedWheres: new Map<string, SQL>() }));

vi.mock('../client.js', () => {
  let pending: SQL | undefined;
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit', 'offset']) {
    chain[method] = () => chain;
  }
  chain.where = (condition: SQL) => {
    pending = condition;
    return chain;
  };
  chain.prepare = (name: string) => {
    if (pending) preparedWheres.set(name, pending);
    pending = undefined;
    return { name };
  };
  return { db: { select: () => chain } };
});

import { initPreparedStatements } from '../prepared.js';

function whereFor(name: string): string {
  initPreparedStatements();
  const condition = preparedWheres.get(name);
  if (!condition) throw new Error(`${name} recorded no WHERE`);
  return renderSql(condition).sql.replace(/\s+/g, ' ').trim();
}

describe('violations_count_since', () => {
  it('carries the full alias filter, so it counts what the joined branch counts', () => {
    const text = whereFor('violations_count_since');

    expect(text).toContain('automation_runs.kind =');
    expect(text).toContain('automation_runs.outcome =');
    expect(text).toContain('automation_runs.server_user_id is not null');
  });

  it('still restricts to the window and drops dismissed runs', () => {
    const text = whereFor('violations_count_since');

    expect(text).toContain('automation_runs.created_at >=');
    expect(text).toContain('automation_runs.dismissed_at is null');
  });
});
