/**
 * Deterministic representative-account ordering for identity-level aggregation.
 *
 * When stats are rolled up by identity (users.id) instead of by server account
 * (server_users.id), one account has to be picked to represent the person for
 * navigation and avatar. This is the same preference order as
 * routes/users/list.ts's DISTINCT ON: an active, Plex-linked, most-active
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
 * The name a person row shows, sorts and searches by: the Tracearr user's, never a media server
 * account's, so a server filter cannot change it. users_display_name_idx holds lower() of it.
 */
export function personNameSql(): SQL {
  return sql`coalesce(u.name, u.username)`;
}
