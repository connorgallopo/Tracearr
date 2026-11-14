/**
 * Deterministic representative-account ordering for identity-level aggregation.
 *
 * When stats are rolled up by identity (users.id) instead of by server account
 * (server_users.id), one account has to be picked to represent the person for
 * navigation, avatar, and username fallback. This is the same preference order
 * as routes/users/list.ts's DISTINCT ON: an active, Plex-linked, most-active
 * account wins over a removed or less-active one.
 *
 * `alias` is the server_users table alias in the query (e.g. 'su2'), correlated
 * against a `users` row aliased `u` in the same statement.
 */

import { sql, type SQL } from 'drizzle-orm';

export function representativeAccountOrderSql(alias: string): SQL {
  return sql.raw(
    `(${alias}.removed_at IS NULL) DESC,
     (${alias}.plex_account_id IS NOT NULL AND ${alias}.plex_account_id = u.plex_account_id) DESC,
     ${alias}.last_activity_at DESC NULLS LAST,
     ${alias}.joined_at ASC NULLS LAST,
     ${alias}.id`
  );
}

/**
 * The person `u`'s own username: their representative account's, picked across every server
 * they are on. A page's server filter narrows which account a row describes, never this, so a
 * merged person keeps one name whichever servers are selected. users.username is not used
 * because sync never rewrites it, so it keeps the old name after a rename on the server.
 */
export function personUsernameSql(): SQL {
  return sql`(
    SELECT person_su.username FROM server_users person_su
    WHERE person_su.user_id = u.id
    ORDER BY ${representativeAccountOrderSql('person_su')}
    LIMIT 1
  )`;
}

/** The name a person row shows and sorts by: the display name, else personUsernameSql. */
export function personNameSql(): SQL {
  return sql`coalesce(u.name, ${personUsernameSql()})`;
}
