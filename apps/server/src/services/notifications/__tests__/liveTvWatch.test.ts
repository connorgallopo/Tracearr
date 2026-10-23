/**
 * Live TV watches: which starts continue a watch, which stop ends it, and what the
 * ending stop reports. The queue-level scenarios (no messages on a programme change,
 * one Stream Ended per watch) are in jobs/__tests__/notificationQueue.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';
import type { LiveSegment } from '../liveTvWatch.js';

const { rows, redisStore, failSelect } = vi.hoisted(() => ({
  rows: [] as LiveSegment[],
  redisStore: new Map<string, string>(),
  failSelect: { on: false },
}));

vi.mock('../../../db/client.js', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => (failSelect.on ? Promise.reject(new Error('db down')) : Promise.resolve(rows)),
  };
  return { db: { select: () => chain } };
});

vi.mock('../../../lib/redisShared.js', () => ({
  getRedis: () => ({
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => redisStore.get(k) ?? null)),
    set: (key: string, value: string) => {
      redisStore.set(key, value);
      return Promise.resolve('OK');
    },
  }),
}));

import { createMockActiveSession } from '../../../test/fixtures.js';
import {
  continuesWatch,
  followsLiveTvWatch,
  LIVE_TV_CHAIN_GAP_MS,
  LIVE_TV_STOP_HOLD_MS,
  liveTvStartContinues,
  resolveHeldLiveTvStop,
  watchEndedBy,
} from '../liveTvWatch.js';

const T0 = new Date('2026-10-23T13:22:53Z').getTime();
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const seg = (id: string, start: number, stop: number | null): LiveSegment => ({
  id,
  startedAt: at(start),
  stoppedAt: stop === null ? null : at(stop),
  durationMs: stop === null ? null : (stop - start) * 1000,
});
const none = new Set<string>();

describe('the hold', () => {
  it('outlasts the gap plus the next session confirming', () => {
    expect(LIVE_TV_CHAIN_GAP_MS).toBe(90_000);
    expect(LIVE_TV_STOP_HOLD_MS).toBeGreaterThanOrEqual(LIVE_TV_CHAIN_GAP_MS + 30_000);
  });

  it('applies only to Live TV with a device id', () => {
    expect(followsLiveTvWatch({ mediaType: 'live', deviceId: 'tv-1' })).toBe(true);
    expect(followsLiveTvWatch({ mediaType: 'live', deviceId: null })).toBe(false);
    expect(followsLiveTvWatch({ mediaType: 'episode', deviceId: 'tv-1' })).toBe(false);
    expect(followsLiveTvWatch({ mediaType: 'movie', deviceId: 'tv-1' })).toBe(false);
  });
});

describe('continuesWatch', () => {
  const a = seg('a', 0, 1015);

  it('folds a programme that starts seconds after the last one stopped', () => {
    const b = seg('b', 1028, null);
    expect(continuesWatch(b, [a, b], none)).toBe(true);
  });

  it('folds a start seen while the previous programme still plays', () => {
    const open = seg('a', 0, null);
    const b = seg('b', 1015, null);
    expect(continuesWatch(b, [open, b], none)).toBe(true);
  });

  it('starts a new watch after a longer gap', () => {
    const b = seg('b', 1015 + 91, null);
    expect(continuesWatch(b, [a, b], none)).toBe(false);
  });

  it('starts a new watch when the previous one already reported its end', () => {
    const b = seg('b', 1030, null);
    expect(continuesWatch(b, [a, b], new Set(['a']))).toBe(false);
  });

  it('is a new watch for the first session', () => {
    expect(continuesWatch(a, [a], none)).toBe(false);
  });
});

describe('watchEndedBy', () => {
  it('leaves the end to the programme that carries on', () => {
    const a = seg('a', 0, 1015);
    const b = seg('b', 1028, null);
    expect(watchEndedBy(a, [a, b], none)).toBeNull();
  });

  it('sums every programme of the watch and starts it at the first', () => {
    const a = seg('a', 0, 1015);
    const b = seg('b', 1028, 1068);
    const c = seg('c', 1072, 2167);
    expect(watchEndedBy(c, [a, b, c], none)).toEqual({
      startedAt: at(0),
      durationMs: (1015 + 40 + 1095) * 1000,
      segments: 3,
    });
  });

  it('stops at a gap longer than the chain gap', () => {
    const earlier = seg('x', -4000, -200);
    const a = seg('a', 0, 600);
    expect(watchEndedBy(a, [earlier, a], none)).toEqual({
      startedAt: at(0),
      durationMs: 600_000,
      segments: 1,
    });
  });

  it('stops at a watch whose end was already reported', () => {
    const a = seg('a', 0, 1015);
    const b = seg('b', 1030, 1600);
    expect(watchEndedBy(b, [a, b], new Set(['a']))?.durationMs).toBe(570_000);
  });

  it('lets exactly one of two overlapping sessions report the end', () => {
    const a = seg('a', 0, 1000);
    const b = seg('b', 990, 1000);
    const ends = [watchEndedBy(a, [a, b], none), watchEndedBy(b, [a, b], none)];
    expect(ends.filter((e) => e !== null)).toHaveLength(1);
  });
});

describe('database-backed decisions', () => {
  const live = (over: Partial<ActiveSession>): ActiveSession =>
    createMockActiveSession({
      serverId: 'srv-1',
      serverUserId: 'su-1',
      deviceId: 'tv-1',
      mediaType: 'live',
      ...over,
    });

  beforeEach(() => {
    rows.length = 0;
    redisStore.clear();
    failSelect.on = false;
  });

  it('announces any start it cannot check', async () => {
    failSelect.on = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await liveTvStartContinues(live({ id: 'b', startedAt: at(1028) }))).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('never reads for anything but Live TV', async () => {
    failSelect.on = true;
    const movie = createMockActiveSession({ mediaType: 'movie', deviceId: 'tv-1' });

    expect(await liveTvStartContinues(movie)).toBe(false);
    expect(await resolveHeldLiveTvStop(movie)).toBe(movie);
  });

  it('sends a held stop unchanged when it cannot check', async () => {
    failSelect.on = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stop = live({ id: 'a', startedAt: at(0), stoppedAt: at(1015), durationMs: 1_015_000 });

    expect(await resolveHeldLiveTvStop(stop)).toBe(stop);
  });

  it('remembers the stop it sent, so a later start is a new watch', async () => {
    rows.push(seg('a', 0, 1015));
    const stop = live({ id: 'a', startedAt: at(0), stoppedAt: at(1015), durationMs: 1_015_000 });

    const sent = await resolveHeldLiveTvStop(stop);
    expect(sent?.durationMs).toBe(1_015_000);

    rows.push(seg('b', 1030, null));
    expect(await liveTvStartContinues(live({ id: 'b', startedAt: at(1030) }))).toBe(false);
  });

  it('reads a payload that came back from the queue as JSON', async () => {
    rows.push(seg('a', 0, 1015), seg('b', 1028, 1600));
    const stop = JSON.parse(
      JSON.stringify(live({ id: 'b', startedAt: at(1028), stoppedAt: at(1600) }))
    ) as ActiveSession;

    const sent = await resolveHeldLiveTvStop(stop);

    expect(sent?.durationMs).toBe((1015 + 572) * 1000);
    expect(new Date(sent?.startedAt ?? 0).getTime()).toBe(T0);
  });
});
