import { sql, type SQL } from 'drizzle-orm';
import countries from 'i18n-iso-countries';
import countriesEn from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import type {
  AutomationFilterOptions,
  CountryOption,
  HistoryFilterOptions,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { startedAtRange } from '../../db/sessions/conditions.js';
import { buildMultiServerFragment, serverIdCondition } from '../../utils/serverFiltering.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';
import { compareNames } from '../../utils/collation.js';
import { serverOrderBy } from '../../utils/serverOrder.js';
import { scopeSessionsRaw, type Scope } from '../../lib/scope.js';

countries.registerLocale(countriesEn);

/** The answer for a caller with no accessible server. */
export function emptyFilterOptions(
  includeAllCountries: boolean | undefined
): HistoryFilterOptions | AutomationFilterOptions {
  const empty: HistoryFilterOptions = {
    platforms: [],
    products: [],
    devices: [],
    countries: [],
    cities: [],
    users: [],
  };
  return includeAllCountries ? { ...empty, servers: [] } : empty;
}

/**
 * The History filter dropdowns, or with includeAllCountries the rules builder's: every
 * country flagged by whether it has sessions, plus the servers.
 */
export async function queryFilterOptions(params: {
  resolvedIds: string[] | undefined;
  scope: Scope;
  accessibleServerIds: string[];
  startDate?: Date;
  endDate?: Date;
  includeAllCountries?: boolean;
}): Promise<HistoryFilterOptions | AutomationFilterOptions> {
  const { resolvedIds, scope, accessibleServerIds, startDate, endDate, includeAllCountries } =
    params;
  const serverConditions = [
    serverIdCondition(resolvedIds, 's.server_id'),
    scopeSessionsRaw(scope, sql`s.server_user_id`),
    ...startedAtRange(startDate, endDate),
  ].filter((condition) => condition !== undefined);

  // Helper to build WHERE clause with additional conditions
  const buildWhereWithCondition = (extraCondition: SQL) => {
    const allConditions = [...serverConditions, extraCondition];
    return sql`WHERE ${sql.join(allConditions, sql` AND `)}`;
  };

  // Query all filter options in parallel
  const [
    platformsResult,
    productsResult,
    devicesResult,
    countriesResult,
    citiesResult,
    usersResult,
    serversResult,
  ] = await Promise.all([
    // Platforms
    db.execute(sql`
          SELECT platform as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
          FROM sessions s
          ${buildWhereWithCondition(sql`platform IS NOT NULL`)}
          GROUP BY platform
          ORDER BY count DESC
          LIMIT 50
        `),
    // Products
    db.execute(sql`
          SELECT product as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
          FROM sessions s
          ${buildWhereWithCondition(sql`product IS NOT NULL`)}
          GROUP BY product
          ORDER BY count DESC
          LIMIT 50
        `),
    // Devices
    db.execute(sql`
          SELECT device as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
          FROM sessions s
          ${buildWhereWithCondition(sql`device IS NOT NULL`)}
          GROUP BY device
          ORDER BY count DESC
          LIMIT 50
        `),
    // Countries (codes with session count)
    db.execute(sql`
          SELECT geo_country as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
          FROM sessions s
          ${buildWhereWithCondition(sql`geo_country IS NOT NULL`)}
          GROUP BY geo_country
          ORDER BY count DESC
          LIMIT 250
        `),
    // Cities
    db.execute(sql`
          SELECT geo_city as value, COUNT(DISTINCT COALESCE(reference_id, id))::int as count
          FROM sessions s
          ${buildWhereWithCondition(sql`geo_city IS NOT NULL`)}
          GROUP BY geo_city
          ORDER BY count DESC
          LIMIT 100
        `),
    // Users - one row per identity (merged accounts collapse to a representative),
    // filtered to identities with sessions matching current filter context.
    db.execute(sql`
      WITH representative AS (
        SELECT DISTINCT ON (su.user_id) su.id, su.user_id
        FROM server_users su
        INNER JOIN users u ON u.id = su.user_id
        WHERE true ${
          serverConditions.length > 0
            ? sql`AND su.id IN (
                SELECT DISTINCT s.server_user_id
                FROM sessions s
                WHERE ${sql.join(serverConditions, sql` AND `)}
              )`
            : sql``
        }
        ORDER BY su.user_id, ${representativeAccountOrderSql('su')}
      )
      SELECT
        su.id,
        su.username,
        su.thumb_url,
        su.server_id,
        u.name as identity_name,
        COALESCE(
          (SELECT ARRAY_AGG(su2.id ORDER BY su2.id)
           FROM server_users su2
           WHERE su2.user_id = su.user_id
           ${buildMultiServerFragment(resolvedIds, 'su2.server_id')}
          ),
          ARRAY[su.id]
        ) AS server_user_ids
      FROM representative rep
      JOIN server_users su ON su.id = rep.id
      LEFT JOIN users u ON u.id = su.user_id
      ORDER BY LOWER(COALESCE(u.name, su.username))
    `),
    // Servers (for rules builder)
    db
      .select({ id: servers.id, name: servers.name, type: servers.type })
      .from(servers)
      .orderBy(...serverOrderBy()),
  ]);

  // Transform users result
  const usersData = (
    usersResult.rows as unknown as {
      id: string;
      username: string;
      thumb_url: string | null;
      server_id: string;
      identity_name: string | null;
      server_user_ids: string[] | null;
    }[]
  ).map((row) => ({
    id: row.id,
    username: row.username,
    thumbUrl: row.thumb_url,
    serverId: row.server_id,
    identityName: row.identity_name,
    serverUserIds: row.server_user_ids ?? [row.id],
  }));
  usersData.sort(
    (a, b) =>
      compareNames(a.identityName ?? a.username, b.identityName ?? b.username) ||
      a.id.localeCompare(b.id)
  );

  const serversData = serversResult
    .filter((row) => scope === 'all' || accessibleServerIds.includes(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
    }));

  // Get countries that have sessions
  const countriesWithSessions = new Set(
    (countriesResult.rows as { value: string }[]).map((r) => r.value)
  );

  // When includeAllCountries is true, return all countries with hasSessions indicator
  if (includeAllCountries) {
    // Get all country codes and names from i18n-iso-countries
    const allCountryNames = countries.getNames('en');
    const allCountries: CountryOption[] = Object.entries(allCountryNames)
      .map(([code, name]) => ({
        code,
        name,
        hasSessions: countriesWithSessions.has(code),
      }))
      .sort((a, b) => {
        // Sort: countries with sessions first, then alphabetically by name
        if (a.hasSessions !== b.hasSessions) {
          return a.hasSessions ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    const rulesResponse: AutomationFilterOptions = {
      platforms: platformsResult.rows as unknown as HistoryFilterOptions['platforms'],
      products: productsResult.rows as unknown as HistoryFilterOptions['products'],
      devices: devicesResult.rows as unknown as HistoryFilterOptions['devices'],
      countries: allCountries,
      cities: citiesResult.rows as unknown as HistoryFilterOptions['cities'],
      users: usersData,
      servers: serversData,
    };

    return rulesResponse;
  }

  // Default response for history page (only countries with sessions)
  const response: HistoryFilterOptions = {
    platforms: platformsResult.rows as unknown as HistoryFilterOptions['platforms'],
    products: productsResult.rows as unknown as HistoryFilterOptions['products'],
    devices: devicesResult.rows as unknown as HistoryFilterOptions['devices'],
    countries: countriesResult.rows as unknown as HistoryFilterOptions['countries'],
    cities: citiesResult.rows as unknown as HistoryFilterOptions['cities'],
    users: usersData,
    servers: serversData,
  };

  return response;
}
