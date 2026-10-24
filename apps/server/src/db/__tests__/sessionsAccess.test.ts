import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SERVER_SRC, lineOf, sourceFiles } from '../../test/sourceFiles.js';

const SESSIONS_READS = [
  /\.(from|leftJoin|innerJoin|leftJoinLateral)\(\s*sessions\s*[,)]/g,
  /(?<!DELETE )\b(FROM|JOIN)\s+sessions(?![\w])/gi,
  /\b(FROM|JOIN)\s+\$\{sessions\}/g,
];

const HOT_PATH = 'writes and hot paths (poller, SSE)';
const IMPORTS = 'imports, maintenance, backfills';
const STATS = 'stats reads that query sessions directly';
const BOUNDED_CALLBACK =
  'the read callback handed to a db/sessions bound (readSessionRow*) names the table';
const PROSE = 'the match is prose in a comment or log line, not a query';
const OPEN_ROWS = 'open-session read: no floor, a session can stay open past 7 days';
const ADMIN = 'maintenance or admin: whole-history counts and merges with no window to bound by';
const OWN_FLOOR = 'carries its own started_at floor in the query';
const ACCESS_HELPER = 'access helper: the run-session lateral is pinned by started_at equality';

/**
 * Every file outside db/sessions/ that reads sessions in query text, with the reason it reads
 * the table directly.
 */
const ALLOWLIST: Record<string, string> = {
  'db/prepared.ts': 'prepared dashboard statements: play counts and watch time since a date',
  'db/timescale.ts': IMPORTS,
  'jobs/importDuplicateCleanup.ts': IMPORTS,
  'jobs/importedHistoryLinking.ts': IMPORTS,
  'jobs/maintenanceQueue.ts': IMPORTS,
  'jobs/poller/database.ts': HOT_PATH,
  'jobs/poller/processor.ts': HOT_PATH,
  'jobs/poller/sessionLifecycle.ts': HOT_PATH,
  'jobs/poller/sessionMapper.ts': HOT_PATH,
  'jobs/poller/violations.ts': HOT_PATH,
  'jobs/serverLocationSync.ts': IMPORTS,
  'jobs/sessionIdentityBackfill.ts': IMPORTS,
  'jobs/sessionNormalize.ts': IMPORTS,
  'jobs/sseProcessor.ts': HOT_PATH,
  'routes/automations.ts': BOUNDED_CALLBACK,
  'routes/debug.ts': ADMIN,
  'routes/library/patterns.ts': STATS,
  'routes/library/stale.ts': 'last watched and watch count per rating key for stale items',
  'routes/mobile.ts': BOUNDED_CALLBACK,
  'routes/public.ts': 'v1 /stats and /users play counts, and a bounded readSessionRow callback',
  'routes/publicV2/shared.ts': 'history candidate window: the newest raw rows before the cursor',
  'routes/publicV2/streams.ts': OWN_FLOOR,
  'routes/runs.ts': BOUNDED_CALLBACK,
  'routes/sessions/aggregates.ts': 'area query module: history aggregates over the filters',
  'routes/sessions/detail.ts': BOUNDED_CALLBACK,
  'routes/sessions/filterOptions.ts': 'area query module: history filter option counts',
  'routes/sessions/history.ts': 'area query module: history keyset page',
  'routes/sessions/index.ts': BOUNDED_CALLBACK,
  'routes/settings.ts': OWN_FLOOR,
  'routes/stats/bandwidth.ts': STATS,
  'routes/stats/content.ts': STATS,
  'routes/stats/devices.ts': STATS,
  'routes/stats/locations.ts': STATS,
  'routes/stats/me.ts': STATS,
  'routes/stats/queries.ts': STATS,
  'routes/users/devices.ts': PROSE,
  'routes/users/locations.ts': PROSE,
  'routes/users/queries/panels.ts':
    'area query module: user locations, devices, termination window',
  'routes/users/queries/plays.ts': 'area query module: per-user play totals, counts, recent plays',
  'routes/violations/queries.ts': 'area query module: the sessions a violation page links to',
  'services/automations/aliasFilter.ts': ACCESS_HELPER,
  'services/automations/systemEventsMigration.ts': IMPORTS,
  'services/automations/wakes/pauseWakes.ts': OPEN_ROWS,
  'services/backup.ts': ADMIN,
  'services/dashboardStats.ts': STATS,
  'services/historicalServers.ts': OPEN_ROWS,
  'services/import/deduplication.ts': IMPORTS,
  'services/library/importedPlayIdentity.ts': IMPORTS,
  'services/library/mediaDetailService.ts':
    'media detail plays and watch time per server, user, device',
  'services/mergeService.ts': ADMIN,
  'services/playbackReporting.ts': IMPORTS,
  'services/stats/peopleStats.ts': STATS,
  'services/stats/topContent.ts': STATS,
  'services/tautulli.ts': IMPORTS,
  'websocket/index.ts': PROSE,
};

describe('sessions access guard', () => {
  it('reads sessions only through db/sessions/ or an allowlisted file', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles()) {
      if (path in ALLOWLIST) continue;
      const text = readFileSync(join(SERVER_SRC, path), 'utf8');
      for (const pattern of SESSIONS_READS) {
        for (const match of text.matchAll(pattern)) {
          offenders.push(`${path}:${lineOf(text, match.index)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every allowlisted path still exists', () => {
    const stale = Object.keys(ALLOWLIST).filter((path) => !existsSync(join(SERVER_SRC, path)));
    expect(stale).toEqual([]);
  });
});
