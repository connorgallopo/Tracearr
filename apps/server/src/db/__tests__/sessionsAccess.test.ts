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
const NOT_MOVED = 'area not moved this round (design, Scope)';
const TASK_2 = 'moves to its area module in Task 2';
const BOUNDED_CALLBACK =
  'the read callback handed to a db/sessions bound (readSessionRow*) names the table';
const PROSE = 'the match is prose in a comment or log line, not a query';
const OPEN_ROWS = 'open-session read: no floor, a session can stay open past 7 days';
const TASK_3 = 'moves to its area module in Task 3 (C1)';
const ADMIN = 'maintenance or admin: whole-history counts and merges with no window to bound by';
const OWN_FLOOR = 'carries its own started_at floor in the query';
const ACCESS_HELPER = 'access helper: the run-session lateral is pinned by started_at equality';

/**
 * Every file outside db/sessions/ that reads sessions in query text. An entry comes off when
 * its area moves onto the module.
 */
const ALLOWLIST: Record<string, string> = {
  'db/prepared.ts': NOT_MOVED,
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
  'jobs/sseProcessor.ts': HOT_PATH,
  'routes/automations.ts': BOUNDED_CALLBACK,
  'routes/debug.ts': ADMIN,
  'routes/library/patterns.ts': NOT_MOVED,
  'routes/library/stale.ts': TASK_3,
  'routes/mobile.ts': BOUNDED_CALLBACK,
  'routes/public.ts': TASK_2,
  'routes/publicV2/shared.ts': TASK_2,
  'routes/publicV2/streams.ts': OWN_FLOOR,
  'routes/runs.ts': BOUNDED_CALLBACK,
  'routes/sessions.ts': TASK_2,
  'routes/settings.ts': OWN_FLOOR,
  'routes/stats/bandwidth.ts': NOT_MOVED,
  'routes/stats/content.ts': NOT_MOVED,
  'routes/stats/devices.ts': NOT_MOVED,
  'routes/stats/locations.ts': NOT_MOVED,
  'routes/stats/me.ts': NOT_MOVED,
  'routes/stats/queries.ts': NOT_MOVED,
  'routes/users/devices.ts': PROSE,
  'routes/users/full.ts': TASK_2,
  'routes/users/list.ts': TASK_2,
  'routes/users/locations.ts': PROSE,
  'routes/users/queries.ts': TASK_2,
  'routes/users/sessions.ts': TASK_2,
  'routes/violations.ts': TASK_2,
  'services/automations/aliasFilter.ts': ACCESS_HELPER,
  'services/automations/systemEventsMigration.ts': IMPORTS,
  'services/automations/wakes/pauseWakes.ts': OPEN_ROWS,
  'services/backup.ts': ADMIN,
  'services/dashboardStats.ts': NOT_MOVED,
  'services/historicalServers.ts': OPEN_ROWS,
  'services/import/deduplication.ts': IMPORTS,
  'services/library/importedPlayIdentity.ts': IMPORTS,
  'services/library/mediaDetailService.ts': NOT_MOVED,
  'services/mergeService.ts': ADMIN,
  'services/playbackReporting.ts': IMPORTS,
  'services/stats/peopleStats.ts': NOT_MOVED,
  'services/stats/topContent.ts': NOT_MOVED,
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
