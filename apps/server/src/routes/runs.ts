/**
 * Automation run routes - the log every automation writes, of every evaluation
 * that reached a run. Summaries never carry the step log; only GET /runs/:id does.
 */

import type { FastifyPluginAsync } from 'fastify';
import { and, count, eq, gte, lt, max, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  runCountsQuerySchema,
  runListQuerySchema,
  uuidSchema,
  type AuthUser,
  type AutomationRun,
  type AutomationRunSummary,
  type GroupEvidence,
  type ListResponse,
  type RunCounts,
  type RunListQuery,
  type RunSessionContext,
  type RunSortField,
  type RunSubject,
  type RunSubjectKind,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import {
  automationRuns,
  automations,
  libraries,
  libraryItems,
  serverUsers,
  servers,
  sessions,
  users,
} from '../db/schema.js';
import { readSessionRow } from '../db/sessionRow.js';
import {
  buildOrderBy,
  utcDayEnd,
  utcDayStart,
  type SortDirection,
  type SortKey,
} from '../utils/listQuery.js';
import { buildMultiServerCondition, resolveServerIds } from '../utils/serverFiltering.js';
import { isLocalSession } from '../utils/localSession.js';
import type { PgSelect } from 'drizzle-orm/pg-core';

const runIdParamSchema = z.object({ id: uuidSchema });

const RUN_SORT_KEYS: Record<RunSortField, SortKey> = {
  startedAt: { key: sql`${automationRuns.startedAt}`, defaultDir: 'desc', nulls: 'last' },
  finishedAt: { key: sql`${automationRuns.finishedAt}`, defaultDir: 'desc', nulls: 'last' },
  outcome: { key: sql`${automationRuns.outcome}`, defaultDir: 'asc' },
};

const MEDIA_SUBJECT_PREFIX = 'media:';
const SERVER_SUBJECT_PREFIX = 'server:';
const INSTALL_SUBJECT_KEY = 'install';

/**
 * A media subject names its library item after the prefix; every other subject key
 * is an id of its own, so the cast only ever sees the media rows. The offset is cast
 * because Postgres types a bare parameter there as text and runs the regex substring().
 */
const mediaSubjectId = sql`CASE WHEN ${automationRuns.subjectKey} LIKE ${`${MEDIA_SUBJECT_PREFIX}%`} THEN substring(${automationRuns.subjectKey} FROM ${MEDIA_SUBJECT_PREFIX.length + 1}::int)::uuid END`;

/** Everything the summary shape needs; the step log stays out by construction. */
const runSummaryColumns = {
  id: automationRuns.id,
  automationId: automationRuns.automationId,
  automationName: automations.name,
  kind: automationRuns.kind,
  outcome: automationRuns.outcome,
  humanSummary: automationRuns.humanSummary,
  severity: automationRuns.severity,
  serverUserId: automationRuns.serverUserId,
  sessionId: automationRuns.sessionId,
  serverId: automationRuns.serverId,
  subjectKey: automationRuns.subjectKey,
  // The joins ride along outside the select chain, so what they can miss is spelled out.
  serverName: sql<string | null>`${servers.name}`,
  accountName: sql<string | null>`${serverUsers.username}`,
  accountThumbUrl: sql<string | null>`${serverUsers.thumbUrl}`,
  personName: sql<string | null>`${users.name}`,
  personUsername: sql<string | null>`${users.username}`,
  itemTitle: sql<string | null>`${libraryItems.title}`,
  itemMediaType: sql<string | null>`${libraryItems.mediaType}`,
  libraryName: sql<string | null>`${libraries.name}`,
  // What the run did, projected off the step log so the log itself stays off the wire.
  // Ordinality rather than DISTINCT: a DISTINCT aggregate sorts alphabetically, and
  // the cell reads as the order the run took. The repeats come out in the mapper.
  ranActions: sql<string[] | null>`(
    SELECT jsonb_agg(step.elem->>'action' ORDER BY step.ord)
    FROM jsonb_array_elements(${automationRuns.steps}) WITH ORDINALITY AS step(elem, ord)
    WHERE jsonb_exists(step.elem, 'action') AND (step.elem->>'success')::boolean
  )`,
  startedAt: automationRuns.startedAt,
  createdAt: automationRuns.createdAt,
  finishedAt: automationRuns.finishedAt,
  acknowledgedAt: automationRuns.acknowledgedAt,
  dismissedAt: automationRuns.dismissedAt,
};

/** What the detail route adds on top of the summary: the run's own log. */
const runDetailColumns = {
  ...runSummaryColumns,
  steps: automationRuns.steps,
  evidence: sql<GroupEvidence[] | null>`${automationRuns.data}->'evidence'`,
  // What the recorder stamped on the run itself, for when the session row is not there.
  storedMediaTitle: sql<string | null>`${automationRuns.data}->>'mediaTitle'`,
  storedIpAddress: sql<string | null>`${automationRuns.data}->>'ipAddress'`,
  definitionVersionId: automationRuns.definitionVersionId,
  sessionStartedAt: automationRuns.sessionStartedAt,
};

/**
 * A run stores ids; the reader wants names. Every join is at most one row deep and
 * none of them can multiply a run, so the page and its count share this shape.
 */
function withRunJoins<T extends PgSelect>(query: T) {
  return query
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .leftJoin(servers, eq(servers.id, automationRuns.serverId))
    .leftJoin(serverUsers, eq(serverUsers.id, automationRuns.serverUserId))
    .leftJoin(users, eq(users.id, serverUsers.userId))
    .leftJoin(libraryItems, eq(libraryItems.id, mediaSubjectId))
    .leftJoin(
      libraries,
      and(
        eq(libraries.serverId, libraryItems.serverId),
        eq(libraries.libraryId, libraryItems.libraryId)
      )
    );
}

export interface RunPageParams {
  where: SQL | undefined;
  orderBy: RunSortField;
  orderDir: SortDirection | undefined;
  pageSize: number;
  offset: number;
}

/**
 * The one run-summary query. GET /runs and GET /automations/:id/runs differ only
 * in what they put in `where`, so neither can drift into a different row shape.
 */
export function buildRunSummaryQuery(params: RunPageParams) {
  return withRunJoins(db.select(runSummaryColumns).from(automationRuns).$dynamic())
    .where(params.where)
    .orderBy(
      buildOrderBy(RUN_SORT_KEYS, params.orderBy, params.orderDir, sql`${automationRuns.id}`)
    )
    .limit(params.pageSize)
    .offset(params.offset);
}

/** Counted off the same joins the page uses, so the pager cannot disagree with it. */
export async function countRuns(where: SQL | undefined): Promise<number> {
  const rows = await withRunJoins(
    db.select({ total: count() }).from(automationRuns).$dynamic()
  ).where(where);
  return rows[0]?.total ?? 0;
}

export type RunSummaryRow = Awaited<ReturnType<typeof buildRunSummaryQuery>>[number];

/** Which of the five things a run can be about this one was, read off its subject key. */
function subjectKindOf(row: Pick<RunSummaryRow, 'subjectKey' | 'sessionId'>): RunSubjectKind {
  const key = row.subjectKey;
  if (key === INSTALL_SUBJECT_KEY) return 'install';
  if (key?.startsWith(MEDIA_SUBJECT_PREFIX)) return 'media';
  if (key?.startsWith(SERVER_SUBJECT_PREFIX)) return 'server';
  return row.sessionId === null ? 'account' : 'session';
}

function subjectOf(row: RunSummaryRow): RunSubject {
  const kind = subjectKindOf(row);
  const media = kind === 'media';
  return {
    kind,
    name: media ? row.itemTitle : row.accountName,
    personName: media ? null : (row.personName ?? row.personUsername),
    thumbUrl: media ? null : row.accountThumbUrl,
    serverName: row.serverName,
    libraryName: media ? row.libraryName : null,
    mediaType: media ? row.itemMediaType : null,
  };
}

export const mapRunSummary = (row: RunSummaryRow): AutomationRunSummary => ({
  id: row.id,
  automationId: row.automationId,
  automationName: row.automationName,
  kind: row.kind,
  outcome: row.outcome,
  humanSummary: row.humanSummary,
  severity: row.severity ?? null,
  serverUserId: row.serverUserId,
  sessionId: row.sessionId,
  serverId: row.serverId,
  subjectKey: row.subjectKey,
  subject: subjectOf(row),
  ranActions: [...new Set(row.ranActions ?? [])],
  startedAt: (row.startedAt ?? row.createdAt).toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
  dismissedAt: row.dismissedAt?.toISOString() ?? null,
});

/**
 * Its own read rather than a join: the sessions hypertable is keyed on (id, started_at),
 * so joining it by id alone would scan every chunk for every run a page lists.
 * A session the run names may still be absent - the row was cleaned up by hand, or the
 * run predates it - which is what the stored fallback below is for.
 */
async function loadSessionContext(
  sessionId: string | null,
  startedAt: Date | null
): Promise<RunSessionContext | null> {
  if (sessionId === null) return null;
  const row = await readSessionRow(sessionId, startedAt, (where) =>
    db
      .select({
        mediaTitle: sessions.mediaTitle,
        mediaType: sessions.mediaType,
        grandparentTitle: sessions.grandparentTitle,
        mediaId: sessions.mediaId,
        showMediaId: sessions.showMediaId,
        player: sessions.playerName,
        device: sessions.device,
        product: sessions.product,
        platform: sessions.platform,
        ipAddress: sessions.ipAddress,
        city: sessions.geoCity,
        country: sessions.geoCountry,
        isLocal: sessions.isLocal,
        geoLat: sessions.geoLat,
      })
      .from(sessions)
      .where(where)
      .limit(1)
      .then((rows) => rows[0])
  );
  if (!row) return null;
  const { isLocal, geoLat, ...context } = row;
  return {
    ...context,
    isLocal: isLocalSession({ isLocal, geoCountry: row.country, geoCity: row.city, geoLat }),
  };
}

/** The two fields the recorder copies onto the run, so a missing session still says something. */
function storedSessionContext(row: {
  storedMediaTitle: string | null;
  storedIpAddress: string | null;
}): RunSessionContext | null {
  if (row.storedMediaTitle === null && row.storedIpAddress === null) return null;
  return {
    mediaTitle: row.storedMediaTitle,
    mediaType: null,
    grandparentTitle: null,
    player: null,
    device: null,
    product: null,
    platform: null,
    ipAddress: row.storedIpAddress,
    city: null,
    country: null,
    isLocal: false,
    mediaId: null,
    showMediaId: null,
  };
}

/**
 * The recorder stamps the server on every run, user-less ones included; a caller sees the
 * servers it can reach, and install-wide runs carry no server, so only owners read those.
 */
export function runAccessCondition(authUser: AuthUser): {
  empty: boolean;
  condition: SQL | undefined;
} {
  const resolvedIds = resolveServerIds(authUser, undefined, undefined, { strict: false });
  if (resolvedIds?.length === 0) return { empty: true, condition: undefined };
  return {
    empty: false,
    condition: buildMultiServerCondition(resolvedIds, automationRuns.serverId),
  };
}

export type RunFilters = Omit<RunListQuery, 'page' | 'pageSize' | 'orderBy' | 'orderDir'>;

export function runFilterConditions(filters: RunFilters): SQL[] {
  const conditions: SQL[] = [];
  if (filters.kind) conditions.push(eq(automationRuns.kind, filters.kind));
  if (filters.outcome) conditions.push(eq(automationRuns.outcome, filters.outcome));
  if (filters.automationId) {
    conditions.push(eq(automationRuns.automationId, filters.automationId));
  }
  const startDate = utcDayStart(filters.startDate);
  if (startDate) conditions.push(gte(automationRuns.startedAt, startDate));
  const endDate = utcDayEnd(filters.endDate);
  if (endDate) conditions.push(lt(automationRuns.startedAt, endDate));
  return conditions;
}

/** Every outcome at zero, so a tab that has never happened still says so. */
function emptyCounts(): RunCounts {
  return { completed: 0, stopped_by_condition: 0, error: 0, total: 0, lastRunAt: null };
}

export const runRoutes: FastifyPluginAsync = async (app) => {
  const readRuns = { preHandler: [app.requirePermission('runs', 'read')] };
  /**
   * GET /runs/counts - How many runs each outcome holds, under the same filters
   */
  app.get('/counts', readRuns, async (request, reply) => {
    const query = runCountsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const access = runAccessCondition(request.user);
    if (access.empty) return emptyCounts();

    const conditions = runFilterConditions(query.data);
    if (access.condition) conditions.push(access.condition);

    const rows = await withRunJoins(
      db
        .select({
          outcome: automationRuns.outcome,
          total: count(),
          newest: max(automationRuns.startedAt),
        })
        .from(automationRuns)
        .$dynamic()
    )
      .where(and(...conditions))
      .groupBy(automationRuns.outcome);

    const counts = emptyCounts();
    for (const row of rows) {
      counts[row.outcome] = row.total;
      counts.total += row.total;
      // The header's run line means the last run that did something, not the last check.
      if (row.outcome === 'completed') counts.lastRunAt = row.newest?.toISOString() ?? null;
    }
    return counts;
  });

  /**
   * GET /runs - Every automation's runs, newest first
   */
  app.get('/', readRuns, async (request, reply) => {
    const query = runListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, orderBy, orderDir, ...filters } = query.data;
    const access = runAccessCondition(request.user);
    if (access.empty) {
      return { data: [], meta: { page, pageSize, total: 0 } } satisfies ListResponse<never>;
    }

    const conditions = runFilterConditions(filters);
    if (access.condition) conditions.push(access.condition);
    const where = and(...conditions);

    const rows = await buildRunSummaryQuery({
      where,
      orderBy,
      orderDir,
      pageSize,
      offset: (page - 1) * pageSize,
    });

    return {
      data: rows.map(mapRunSummary),
      meta: { page, pageSize, total: await countRuns(where) },
    } satisfies ListResponse<AutomationRunSummary>;
  });

  /**
   * GET /runs/:id - One run with its step log
   */
  app.get('/:id', readRuns, async (request, reply) => {
    const params = runIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid run ID');
    }

    const access = runAccessCondition(request.user);
    if (access.empty) return reply.notFound('Run not found');

    const rows = await withRunJoins(db.select(runDetailColumns).from(automationRuns).$dynamic())
      .where(and(eq(automationRuns.id, params.data.id), access.condition))
      .limit(1);

    const row = rows[0];
    if (!row) return reply.notFound('Run not found');

    return {
      ...mapRunSummary(row),
      steps: row.steps ?? [],
      session:
        (await loadSessionContext(row.sessionId, row.sessionStartedAt)) ??
        storedSessionContext(row),
      evidence: Array.isArray(row.evidence) ? row.evidence : [],
      definitionVersionId: row.definitionVersionId,
    } satisfies AutomationRun;
  });
};
