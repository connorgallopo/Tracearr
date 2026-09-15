import { sql, type SQL } from 'drizzle-orm';
import type { NewsletterScopeLibrary } from '@tracearr/shared';

/** Row values for `(server_id, library_id) IN (...)`; drizzle's array expansion only builds flat lists. */
export function libraryPairs(libraries: readonly NewsletterScopeLibrary[]): SQL {
  return sql`(${sql.join(
    libraries.map((l) => sql`(${l.serverId}::uuid, ${l.libraryId})`),
    sql`, `
  )})`;
}
