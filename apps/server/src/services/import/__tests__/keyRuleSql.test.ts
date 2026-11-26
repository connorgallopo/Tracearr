import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  keyAgreesSql,
  normalizedShowTitleSql,
  normalizedTitleSql,
  repairClauseSql,
  serverTypesSql,
} from '../keyRuleSql.js';

describe('key rule SQL', () => {
  it('is pure ASCII, so no client encoding conversion can reject it', () => {
    const dialect = new PgDialect();
    const texts = [
      normalizedTitleSql('t'),
      normalizedShowTitleSql('t'),
      dialect.sqlToQuery(keyAgreesSql('item')).sql,
      dialect.sqlToQuery(repairClauseSql()).sql,
    ];
    for (const text of texts) expect(text).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('lists no server types as an empty array, not an empty list', () => {
    expect(serverTypesSql(() => false)).toBe('ARRAY[]::text[]');
  });
});
