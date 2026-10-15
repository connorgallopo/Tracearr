import { describe, it, expect, vi, beforeEach } from 'vitest';
import { REDIS_KEYS } from '@tracearr/shared';

const { redis, invalidatePattern, getSetting } = vi.hoisted(() => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  invalidatePattern: vi.fn(),
  getSetting: vi.fn(),
}));

vi.mock('../redisShared.js', () => ({ getRedis: () => redis }));
vi.mock('../../services/cache.js', () => ({ getCacheService: () => ({ invalidatePattern }) }));
vi.mock('../../services/settings.js', () => ({ getSetting }));
vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));

import { db } from '../../db/client.js';
import { queryChain, renderCall, renderSql } from '../../test/helpers.js';
import {
  ACCESS_CACHE_TTL_MS,
  assertInScope,
  clearScope,
  hasPermission,
  libraryCacheSegment,
  libraryFragment,
  loadScope,
  memberCacheSegment,
  scopeSessions,
  scopeSessionsRaw,
  scopedServerFragment,
  seesServerActivity,
} from '../scope.js';
import { sql } from 'drizzle-orm';

const member = { userId: 'u-1', serverUserIds: ['su-1', 'su-2'], serverIds: ['srv-a', 'srv-b'] };

beforeEach(() => {
  vi.clearAllMocks();
  redis.get.mockResolvedValue(null);
});

describe('loadScope', () => {
  it.each(['owner', 'admin'] as const)(
    'gives %s every row without touching Redis',
    async (role) => {
      expect(await loadScope('u-1', role)).toBe('all');
      expect(redis.get).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    }
  );

  it('reads a member scope from the cache', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({ serverUserIds: member.serverUserIds, serverIds: member.serverIds })
    );

    expect(await loadScope('u-1', 'member')).toEqual(member);
    expect(redis.get).toHaveBeenCalledWith(REDIS_KEYS.USER_SCOPE('u-1'));
    expect(db.select).not.toHaveBeenCalled();
  });

  it('takes every non-removed account on every server, whatever its member login switch', async () => {
    const chain = queryChain(vi.fn, [
      { id: 'su-1', serverId: 'srv-a', libraryIds: ['lib-1'] },
      { id: 'su-2', serverId: 'srv-b', libraryIds: null },
    ]);
    vi.mocked(db.select).mockReturnValue(chain);
    const limited = { ...member, libraryIds: { 'srv-a': ['lib-1'] } };

    expect(await loadScope('u-1', 'member')).toEqual(limited);

    const { text, params } = renderCall(chain);
    expect(text).toBe('(server_users.user_id = $1 and server_users.removed_at is null)');
    expect(text).not.toContain('allow_member_login');
    expect(chain.innerJoin).not.toHaveBeenCalled();
    expect(params).toEqual(['u-1']);
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.USER_SCOPE('u-1'),
      JSON.stringify(limited),
      'PX',
      ACCESS_CACHE_TTL_MS
    );
  });

  it('lets two accounts on one server open what either can', async () => {
    vi.mocked(db.select).mockReturnValue(
      queryChain(vi.fn, [
        { id: 'su-1', serverId: 'srv-a', libraryIds: ['lib-2'] },
        { id: 'su-2', serverId: 'srv-a', libraryIds: ['lib-1', 'lib-2'] },
        { id: 'su-3', serverId: 'srv-b', libraryIds: ['lib-9'] },
        { id: 'su-4', serverId: 'srv-b', libraryIds: null },
      ])
    );

    expect(await loadScope('u-1', 'member')).toEqual({
      userId: 'u-1',
      serverUserIds: ['su-1', 'su-2', 'su-3', 'su-4'],
      serverIds: ['srv-a', 'srv-b'],
      libraryIds: { 'srv-a': ['lib-1', 'lib-2'] },
    });
  });

  it('scopes a person with no live account to nothing', async () => {
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, []));

    expect(await loadScope('u-1', 'member')).toEqual({
      userId: 'u-1',
      serverUserIds: [],
      serverIds: [],
      libraryIds: {},
    });
  });
});

describe('libraryFragment', () => {
  it('narrows a limited account to its libraries and keys its cache apart', () => {
    const limited = { ...member, libraryIds: { 'srv-b': ['lib-2', 'lib-3'], 'srv-a': [] } };
    const rendered = renderSql(libraryFragment(['srv-a', 'srv-b'], limited, 'li'));

    expect(rendered.sql.replace(/\s+/g, ' ').trim()).toBe(
      'AND li.server_id IN ($1, $2) AND (li.server_id <> $3::uuid OR li.library_id IN ($4, $5)) AND li.server_id <> $6::uuid'
    );
    expect(rendered.params).toEqual(['srv-a', 'srv-b', 'srv-b', 'lib-2', 'lib-3', 'srv-a']);
    expect(renderSql(libraryFragment(['srv-a'], member, 'li')).sql.trim()).toBe(
      'AND li.server_id = $1'
    );
    expect(libraryCacheSegment(limited)).toBe(':libs:srv-a=,srv-b=lib-2+lib-3');
    expect(libraryCacheSegment(member)).toBe('');
    expect(libraryCacheSegment('all')).toBe('');
  });
});

describe('clearScope', () => {
  it('deletes the cached scope and every answer cached for that member', async () => {
    await clearScope('u-1');
    expect(redis.del).toHaveBeenCalledWith(REDIS_KEYS.USER_SCOPE('u-1'));
    expect(invalidatePattern.mock.calls).toEqual([
      ['tracearr:*:member:u-1*'],
      [REDIS_KEYS.FILTER_OPTIONS('u-1', '*')],
    ]);
    expect(`${REDIS_KEYS.DASHBOARD_STATS}:all${memberCacheSegment(member)}:UTC`).toMatch(
      /^tracearr:.*:member:u-1/
    );
  });
});

describe('seesServerActivity', () => {
  it('is always on for owner and admin, and follows the owner switch for a member', async () => {
    expect(await seesServerActivity('all')).toBe(true);
    expect(getSetting).not.toHaveBeenCalled();
    getSetting.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await seesServerActivity(member)).toBe(false);
    expect(await seesServerActivity(member)).toBe(true);
    expect(getSetting).toHaveBeenCalledWith('memberServerActivity');
  });
});

describe('scopedServerFragment', () => {
  it('appends the account filter to the server filter', () => {
    const rendered = renderSql(
      scopedServerFragment(['srv-a'], member, 's.server_id', sql`s.server_user_id`)
    );
    expect(rendered.sql.replace(/\s+/g, ' ').trim()).toBe(
      'AND s.server_id = $1 AND s.server_user_id IN ($2, $3)'
    );
    expect(renderSql(scopedServerFragment(undefined, 'all')).sql.trim()).toBe('');
  });
});

describe('scopeSessions', () => {
  it('adds nothing for all', () => {
    expect(scopeSessions('all')).toBeUndefined();
    expect(scopeSessionsRaw('all', sql`s.server_user_id`)).toBeUndefined();
  });

  it('matches nothing for a member with no accounts', () => {
    const empty = { userId: 'u-1', serverUserIds: [], serverIds: [] };
    expect(renderSql(scopeSessions(empty)!).sql).toBe('false');
    expect(renderSql(scopeSessionsRaw(empty, sql`s.server_user_id`)!).sql).toBe('false');
  });

  it('limits to the member account ids', () => {
    const builder = renderSql(scopeSessions(member)!);
    expect(builder.sql).toBe('sessions.server_user_id in ($1, $2)');
    expect(builder.params).toEqual(['su-1', 'su-2']);

    const raw = renderSql(scopeSessionsRaw(member, sql`s.server_user_id`)!);
    expect(raw.sql).toBe('s.server_user_id IN ($1, $2)');
    expect(raw.params).toEqual(['su-1', 'su-2']);
  });
});

describe('assertInScope', () => {
  it('passes anything for all and only own accounts for a member', () => {
    expect(assertInScope('all', 'su-9')).toBe(true);
    expect(assertInScope(member, 'su-2')).toBe(true);
    expect(assertInScope(member, 'su-9')).toBe(false);
  });
});

describe('hasPermission', () => {
  it('lets a member read their own surfaces and nothing else', () => {
    expect(hasPermission('member', 'sessions', 'read')).toBe(true);
    expect(hasPermission('member', 'media', 'read')).toBe(true);
    expect(hasPermission('member', 'sessions', 'terminate')).toBe(false);
    expect(hasPermission('member', 'requests', 'write')).toBe(false);
    expect(hasPermission('member', 'users', 'read')).toBe(false);
    expect(hasPermission('member', 'settings', 'read')).toBe(false);
  });

  it('gives admin every app statement but not the role endpoints', () => {
    expect(hasPermission('admin', 'users', 'merge')).toBe(true);
    expect(hasPermission('admin', 'sessions', 'terminate')).toBe(true);
    expect(hasPermission('admin', 'user', 'set-role')).toBe(false);
  });

  it('refuses roles that never sign in', () => {
    expect(hasPermission('disabled', 'media', 'read')).toBe(false);
    expect(hasPermission('pending', 'media', 'read')).toBe(false);
  });
});
