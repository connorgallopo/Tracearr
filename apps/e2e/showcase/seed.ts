/**
 * Fills an isolated database with the showcase cast so the capture run has a
 * lived-in install to photograph. Raw SQL against the migrated schema, same
 * boundary rule as seed/seedCore.ts: nothing here imports apps/server source.
 */

import type { Client } from 'pg';
import Redis from 'ioredis';
import { variantKey, type ActiveSession } from '@tracearr/shared';
import { fixtureId, matchKeyLocal, normalizeTitleLocal, sortTitleLocal } from '../seed/fixtures';
import {
  ACTIVE_STREAMS,
  AUTOMATIONS,
  CAST,
  DEVICES,
  EXTERNAL_URL,
  LIBRARIES,
  OWNER,
  PEOPLE,
  SAO_PAULO,
  SERVERS,
  SHANGHAI,
  hashSeed,
  intBetween,
  loadTitles,
  pick,
  pickWeighted,
  rng,
  type ServerKey,
  type ShowcaseAccount,
  type ShowcaseDevice,
  type ShowcasePerson,
  type ShowcasePlace,
  type ShowcaseTitle,
} from './data';

export interface ShowcaseIds {
  servers: { plex: string; jellyfin: string; emby: string };
  ownerServerUserIds: string[];
  people: Record<string, { userId: string; serverUserIds: Partial<Record<ServerKey, string>> }>;
  activeSessionIds: string[];
  featuredMovieMediaId: string;
  featuredMovieTitle: string;
  /** Keyed `<serverKey>:<libraryId>`, valued with the libraries row id. */
  libraryIds: Record<string, string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 90;
const SESSION_COUNT = 1400;
const RECENT_MOVIES = 9;
const RECENT_SHOWS = 5;

const serverIdOf = (key: ServerKey): string => fixtureId(`showcase:server:${key}`);
const userIdOf = (personKey: string): string => fixtureId(`showcase:user:${personKey}`);
const serverUserIdOf = (personKey: string, server: ServerKey): string =>
  fixtureId(`showcase:server-user:${personKey}:${server}`);
const libraryRowIdOf = (server: ServerKey, libraryId: string): string =>
  fixtureId(`showcase:library:${server}:${libraryId}`);
const mediaIdOf = (title: ShowcaseTitle): string =>
  fixtureId(`showcase:media:${title.type}:${title.title}:${title.year}`);
const itemIdOf = (server: ServerKey, ratingKey: string): string =>
  fixtureId(`showcase:item:${server}:${ratingKey}`);
const sessionIdOf = (key: string): string => fixtureId(`showcase:session:${key}`);

/** The owner id is whatever auth.setup signed up; every other row hangs off these. */
function personById(personKey: string): ShowcasePerson {
  const person = CAST.find((entry) => entry.key === personKey);
  if (!person) throw new Error(`Unknown showcase person: ${personKey}`);
  return person;
}

function deviceById(key: string): ShowcaseDevice {
  const device = DEVICES[key];
  if (!device) throw new Error(`Unknown showcase device: ${key}`);
  return device;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Multi-row INSERT in bind-parameter-sized chunks. Table and column names are
 * literal constants from this file, never input.
 */
async function insertRows(
  client: Client,
  table: string,
  columns: string[],
  rows: unknown[][],
  chunkSize = 500
): Promise<void> {
  for (const batch of chunk(rows, chunkSize)) {
    const tuples = batch
      .map(
        (_, rowIndex) =>
          `(${columns.map((_col, colIndex) => `$${rowIndex * columns.length + colIndex + 1}`).join(', ')})`
      )
      .join(', ');
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples}`,
      batch.flat()
    );
  }
}

interface TitleCopy {
  serverKey: ServerKey;
  ratingKey: string;
  resolution: string;
  dynamicRange: string;
  fileSize: number;
  libraryId: string;
}

interface SeasonPlan {
  number: number;
  episodeCount: number;
}

interface CatalogTitle {
  index: number;
  spec: ShowcaseTitle;
  mediaId: string;
  addedAt: Date;
  copies: TitleCopy[];
  seasons: SeasonPlan[];
  episodeRuntimeMs: number;
  movieRuntimeMs: number;
}

const RESOLUTION_SHARE: Record<string, number> = { '4k': 1, '1080p': 0.42, '720p': 0.18 };
const QUALITY_LABEL: Record<string, string> = { '4k': '4K', '1080p': '1080p', '720p': '720p' };
const FRAME_SIZE: Record<string, [number, number]> = {
  '4k': [3840, 2160],
  '1080p': [1920, 1080],
  '720p': [1280, 720],
};

function movieResolution(server: ServerKey, index: number, base: string): string {
  if (server === 'plex') return base;
  const down = base === '4k' ? '1080p' : '720p';
  if (server === 'jellyfin') return index % 2 === 0 ? down : base;
  return index % 5 === 0 ? '720p' : base;
}

function showResolution(server: ServerKey, index: number): string {
  if (server === 'plex') return index % 4 === 0 ? '4k' : '1080p';
  if (server === 'jellyfin') {
    if (index % 3 === 0) return '4k';
    return index % 2 === 0 ? '1080p' : '720p';
  }
  return '1080p';
}

function dynamicRangeFor(resolution: string, index: number): string {
  if (resolution !== '4k') return 'sdr';
  if (index % 3 === 0) return 'dolby vision';
  return index % 3 === 1 ? 'hdr10' : 'sdr';
}

function serversFor(index: number): ServerKey[] {
  const keys: ServerKey[] = ['plex'];
  if (index % 3 !== 2) keys.push('jellyfin');
  if (index % 2 === 0) keys.push('emby');
  return keys;
}

/** Newest 14 titles land inside the digest window; the rest walk back over the history. */
function addedAtFor(now: Date, recentRank: number, index: number, total: number): Date {
  if (recentRank >= 0) {
    const daysAgo = 0.6 + (recentRank * 6) / (RECENT_MOVIES + RECENT_SHOWS);
    return new Date(now.getTime() - daysAgo * DAY_MS);
  }
  const daysAgo =
    8 + (((index * 79) / Math.max(total - 1, 1) + (hashSeed(String(index)) % 5)) % 79);
  return new Date(now.getTime() - daysAgo * DAY_MS);
}

function buildCatalog(now: Date): CatalogTitle[] {
  const titles = loadTitles();
  const recent = new Set<number>();
  let movies = 0;
  let shows = 0;
  titles.forEach((title, index) => {
    if (title.type === 'movie' && movies < RECENT_MOVIES) {
      recent.add(index);
      movies++;
    }
    if (title.type === 'show' && shows < RECENT_SHOWS) {
      recent.add(index);
      shows++;
    }
  });
  const recentOrder = [...recent].sort((a, b) => a - b);

  return titles.map((spec, index) => {
    const random = rng(`showcase:title:${index}`);
    const baseResolution = spec.resolution ?? '1080p';
    const copies: TitleCopy[] = serversFor(index).map((serverKey) => {
      const resolution =
        spec.type === 'movie'
          ? movieResolution(serverKey, index, baseResolution)
          : showResolution(serverKey, index);
      const baseSize = spec.fileSize ?? 4 * 1024 ** 3;
      const scale =
        (RESOLUTION_SHARE[resolution] ?? 0.42) / (RESOLUTION_SHARE[baseResolution] ?? 0.42);
      return {
        serverKey,
        ratingKey: `${index + 1}`,
        resolution,
        dynamicRange: dynamicRangeFor(resolution, index),
        fileSize: Math.round(baseSize * scale * (0.85 + random() * 0.3)),
        libraryId: spec.type === 'movie' ? 'movies' : 'tv',
      };
    });

    const seasonCount = spec.type === 'show' ? 2 + (hashSeed(`s:${spec.title}`) % 5) : 0;
    const seasons: SeasonPlan[] = [];
    for (let number = 1; number <= seasonCount; number++) {
      seasons.push({ number, episodeCount: 8 + (hashSeed(`e:${spec.title}:${number}`) % 5) });
    }

    return {
      index,
      spec,
      mediaId: mediaIdOf(spec),
      addedAt: addedAtFor(now, recentOrder.indexOf(index), index, titles.length),
      copies,
      seasons,
      episodeRuntimeMs: (22 + (hashSeed(`r:${spec.title}`) % 34)) * 60_000,
      movieRuntimeMs: (92 + (hashSeed(`m:${spec.title}`) % 58)) * 60_000,
    };
  });
}

const copyOn = (title: CatalogTitle, server: ServerKey): TitleCopy | undefined =>
  title.copies.find((copy) => copy.serverKey === server);

function featuredMovie(catalog: CatalogTitle[]): CatalogTitle {
  const featured = catalog.find(
    (title) =>
      title.spec.type === 'movie' &&
      title.copies.length === 3 &&
      copyOn(title, 'plex')?.resolution === '4k'
  );
  if (!featured) throw new Error('No 4K movie exists on all three showcase servers');
  return featured;
}

interface SessionRow {
  id: string;
  serverKey: ServerKey;
  serverUserId: string;
  sessionKey: string;
  state: 'playing' | 'paused' | 'stopped';
  mediaType: 'movie' | 'episode';
  mediaTitle: string;
  grandparentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  year: number | null;
  thumbPath: string;
  ratingKey: string;
  mediaId: string;
  showMediaId: string | null;
  startedAt: Date;
  stoppedAt: Date | null;
  lastSeenAt: Date;
  durationMs: number;
  totalDurationMs: number;
  progressMs: number;
  watched: boolean;
  place: ShowcasePlace;
  device: ShowcaseDevice;
  deviceId: string;
  quality: string;
  isTranscode: boolean;
  bitrate: number;
  sourceResolution: string;
}

const SESSION_COLUMNS = [
  'id',
  'server_id',
  'server_user_id',
  'session_key',
  'state',
  'media_type',
  'media_title',
  'grandparent_title',
  'season_number',
  'episode_number',
  'year',
  'thumb_path',
  'rating_key',
  'media_id',
  'show_media_id',
  'started_at',
  'stopped_at',
  'last_seen_at',
  'duration_ms',
  'total_duration_ms',
  'progress_ms',
  'watched',
  'ip_address',
  'geo_city',
  'geo_region',
  'geo_country',
  'geo_continent',
  'geo_postal',
  'geo_lat',
  'geo_lon',
  'geo_asn_number',
  'geo_asn_organization',
  'player_name',
  'device_id',
  'product',
  'device',
  'platform',
  'quality',
  'is_transcode',
  'video_decision',
  'audio_decision',
  'bitrate',
  'source_video_codec',
  'stream_video_codec',
  'source_video_width',
  'source_video_height',
  'source_audio_codec',
  'source_audio_channels',
  'source_video_details',
  'stream_video_details',
  'transcode_info',
];

const transcodeInfoOf = (row: SessionRow): Record<string, unknown> | null =>
  row.isTranscode
    ? {
        containerDecision: 'transcode',
        sourceContainer: 'mkv',
        streamContainer: 'mp4',
        hwDecoding: 'nvdec',
        hwEncoding: 'nvenc',
        speed: 1.8,
        throttled: false,
      }
    : null;

const sourceVideoDetailsOf = (row: SessionRow): Record<string, unknown> => ({
  bitrate: row.isTranscode ? Math.round(row.bitrate * 1.6) : row.bitrate,
  framerate: '24p',
  dynamicRange: row.sourceResolution === '4k' ? 'HDR10' : 'SDR',
});

const streamVideoDetailsOf = (row: SessionRow): Record<string, unknown> | null => {
  if (!row.isTranscode) return null;
  const [width, height] = FRAME_SIZE['1080p'] ?? [1920, 1080];
  return { bitrate: row.bitrate, width, height, framerate: '24p', dynamicRange: 'SDR' };
};

function sessionValues(row: SessionRow): unknown[] {
  const [width, height] = FRAME_SIZE[row.sourceResolution] ?? [1920, 1080];
  const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));
  return [
    row.id,
    serverIdOf(row.serverKey),
    row.serverUserId,
    row.sessionKey,
    row.state,
    row.mediaType,
    row.mediaTitle,
    row.grandparentTitle,
    row.seasonNumber,
    row.episodeNumber,
    row.year,
    row.thumbPath,
    row.ratingKey,
    row.mediaId,
    row.showMediaId,
    row.startedAt,
    row.stoppedAt,
    row.lastSeenAt,
    row.durationMs,
    row.totalDurationMs,
    row.progressMs,
    row.watched,
    row.place.ip,
    row.place.city,
    row.place.region,
    row.place.country,
    row.place.continent,
    row.place.postal,
    row.place.lat,
    row.place.lon,
    row.place.asnNumber,
    row.place.asnOrganization,
    row.device.playerName,
    row.deviceId,
    row.device.product,
    row.device.device,
    row.device.platform,
    row.quality,
    row.isTranscode,
    row.isTranscode ? 'transcode' : 'directplay',
    row.isTranscode ? 'transcode' : 'directplay',
    row.bitrate,
    row.sourceResolution === '4k' ? 'hevc' : 'h264',
    row.isTranscode ? 'h264' : null,
    width,
    height,
    row.sourceResolution === '4k' ? 'eac3' : 'aac',
    row.sourceResolution === '4k' ? 6 : 2,
    json(sourceVideoDetailsOf(row)),
    json(streamVideoDetailsOf(row)),
    json(transcodeInfoOf(row)),
  ];
}

function bitrateFor(random: () => number, resolution: string, transcoding: boolean): number {
  if (resolution === '4k')
    return transcoding ? intBetween(random, 8000, 12000) : intBetween(random, 25000, 45000);
  if (resolution === '1080p') return intBetween(random, 6000, 12000);
  return intBetween(random, 2500, 4000);
}

interface PlaybackChoice {
  title: CatalogTitle;
  copy: TitleCopy;
  mediaType: 'movie' | 'episode';
  mediaTitle: string;
  grandparentTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  ratingKey: string;
  totalDurationMs: number;
}

function choosePlayback(
  random: () => number,
  catalog: CatalogTitle[],
  serverKey: ServerKey,
  kind: 'movie' | 'episode'
): PlaybackChoice {
  const wanted = kind === 'movie' ? 'movie' : 'show';
  const pool = catalog.flatMap((title) => {
    const copy = copyOn(title, serverKey);
    return title.spec.type === wanted && copy ? [{ title, copy }] : [];
  });
  // Zipf over catalog order: the shelves and the top-content lists need a head.
  const { title, copy } = pickWeighted(random, pool, (entry) => 1 / (1 + entry.title.index * 0.12));
  if (kind === 'movie') {
    return {
      title,
      copy,
      mediaType: 'movie',
      mediaTitle: title.spec.title,
      grandparentTitle: null,
      seasonNumber: null,
      episodeNumber: null,
      ratingKey: copy.ratingKey,
      totalDurationMs: title.movieRuntimeMs,
    };
  }
  const season = pick(random, title.seasons);
  const episode = intBetween(random, 1, season.episodeCount);
  return {
    title,
    copy,
    mediaType: 'episode',
    mediaTitle: `Episode ${episode}`,
    grandparentTitle: title.spec.title,
    seasonNumber: season.number,
    episodeNumber: episode,
    ratingKey: `${copy.ratingKey}-s${season.number}e${episode}`,
    totalDurationMs: title.episodeRuntimeMs,
  };
}

/** Evenings and weekends carry the history; the rest is scattered daytime viewing. */
function startedAtFor(
  random: () => number,
  now: Date,
  place: ShowcasePlace,
  minDaysAgo: number,
  maxDaysAgo: number
): Date {
  let dayOffset = intBetween(random, minDaysAgo, maxDaysAgo);
  const weekday = new Date(now.getTime() - dayOffset * DAY_MS).getUTCDay();
  if (weekday !== 0 && weekday !== 6 && random() < 0.45) {
    dayOffset = Math.min(maxDaysAgo, dayOffset + ((6 - weekday + 7) % 7));
  }
  const roll = random();
  const localHour =
    roll < 0.6
      ? intBetween(random, 19, 23)
      : roll < 0.9
        ? intBetween(random, 12, 18)
        : intBetween(random, 0, 11);
  const day = new Date(now.getTime() - dayOffset * DAY_MS);
  day.setUTCHours(localHour - place.utcOffset, intBetween(random, 0, 59), 0, 0);
  return day.getTime() > now.getTime() ? new Date(day.getTime() - DAY_MS) : day;
}

function buildHistory(now: Date, catalog: CatalogTitle[]): SessionRow[] {
  const streamers = CAST.filter((person) => person.accounts.length > 0);
  const rows: SessionRow[] = [];

  for (let i = 0; i < SESSION_COUNT; i++) {
    const random = rng(`showcase:history:${i}`);
    const person = pickWeighted(random, streamers, (entry) => entry.weight);
    const account = pick(random, person.accounts);
    // A removed account stopped streaming the day it was removed.
    const minDaysAgo = account.removedDaysAgo === undefined ? 0 : account.removedDaysAgo + 1;
    const startedAt = startedAtFor(random, now, person.place, minDaysAgo, HISTORY_DAYS - 1);

    const kind = random() < 0.7 ? 'episode' : 'movie';
    const playback = choosePlayback(random, catalog, account.server, kind);
    const finished = random() < 0.72;
    const fraction = finished ? 0.86 + random() * 0.13 : 0.05 + random() * 0.62;
    const progressMs = Math.round(playback.totalDurationMs * fraction);
    const pauseMs = random() < 0.2 ? intBetween(random, 60_000, 900_000) : 0;
    const device = deviceById(pick(random, person.devices));
    const isTranscode = random() < 0.2;

    rows.push({
      id: sessionIdOf(`history:${i}`),
      serverKey: account.server,
      serverUserId: serverUserIdOf(person.key, account.server),
      sessionKey: `showcase-${i}`,
      state: 'stopped',
      mediaType: playback.mediaType,
      mediaTitle: playback.mediaTitle,
      grandparentTitle: playback.grandparentTitle,
      seasonNumber: playback.seasonNumber,
      episodeNumber: playback.episodeNumber,
      year: playback.title.spec.year,
      thumbPath: `/posters/${playback.title.spec.poster}`,
      ratingKey: playback.ratingKey,
      mediaId: playback.title.mediaId,
      showMediaId: playback.mediaType === 'episode' ? playback.title.mediaId : null,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + progressMs + pauseMs),
      lastSeenAt: new Date(startedAt.getTime() + progressMs + pauseMs),
      durationMs: progressMs,
      totalDurationMs: playback.totalDurationMs,
      progressMs,
      watched: fraction >= 0.85,
      place: person.place,
      device,
      deviceId: `${person.slug}-${device.key}`,
      quality: QUALITY_LABEL[playback.copy.resolution] ?? '1080p',
      isTranscode,
      bitrate: bitrateFor(random, playback.copy.resolution, isTranscode),
      sourceResolution: playback.copy.resolution,
    });
  }
  return rows;
}

/**
 * The sessions the automation runs point at. Fixed keys, so seedAutomations
 * can link a run to one without threading ids through the caller.
 */
interface ScriptedSpec {
  key: string;
  personKey: string;
  serverKey: ServerKey;
  daysAgo: number;
  hour: number;
  durationMs: number;
  place?: ShowcasePlace;
  deviceKey?: string;
  kind?: 'movie' | 'episode';
}

const SCRIPTED: ScriptedSpec[] = [
  {
    key: 'tom-berlin-1',
    personKey: 'tom',
    serverKey: 'plex',
    daysAgo: 23,
    hour: 20,
    durationMs: 46 * 60_000,
  },
  {
    key: 'tom-sao-paulo-1',
    personKey: 'tom',
    serverKey: 'plex',
    daysAgo: 23,
    hour: 21.5,
    durationMs: 120 * 60_000,
    place: SAO_PAULO,
    kind: 'movie',
  },
  {
    key: 'tom-berlin-2',
    personKey: 'tom',
    serverKey: 'plex',
    daysAgo: 9,
    hour: 19,
    durationMs: 41 * 60_000,
  },
  {
    key: 'tom-sao-paulo-2',
    personKey: 'tom',
    serverKey: 'plex',
    daysAgo: 9,
    hour: 20.5,
    durationMs: 118 * 60_000,
    place: SAO_PAULO,
    kind: 'movie',
  },
  {
    key: 'kenji-shanghai',
    personKey: 'kenji',
    serverKey: 'jellyfin',
    daysAgo: 16,
    hour: 22,
    durationMs: 52 * 60_000,
    place: SHANGHAI,
  },
  {
    key: 'maya-jf-1a',
    personKey: 'maya',
    serverKey: 'jellyfin',
    daysAgo: 27,
    hour: 20,
    durationMs: 55 * 60_000,
  },
  {
    key: 'maya-jf-1b',
    personKey: 'maya',
    serverKey: 'jellyfin',
    daysAgo: 27,
    hour: 20.2,
    durationMs: 48 * 60_000,
    deviceKey: 'iphone',
  },
  {
    key: 'maya-jf-2a',
    personKey: 'maya',
    serverKey: 'jellyfin',
    daysAgo: 6,
    hour: 21,
    durationMs: 51 * 60_000,
  },
  {
    key: 'maya-jf-2b',
    personKey: 'maya',
    serverKey: 'jellyfin',
    daysAgo: 6,
    hour: 21.1,
    durationMs: 44 * 60_000,
    deviceKey: 'iphone',
  },
  {
    key: 'daniel-emby-a',
    personKey: 'daniel',
    serverKey: 'emby',
    daysAgo: 12,
    hour: 19,
    durationMs: 47 * 60_000,
  },
  {
    key: 'daniel-emby-b',
    personKey: 'daniel',
    serverKey: 'emby',
    daysAgo: 12,
    hour: 19.3,
    durationMs: 39 * 60_000,
    deviceKey: 'chrome',
  },
  {
    key: 'owner-plex-a',
    personKey: 'jordan',
    serverKey: 'plex',
    daysAgo: 4,
    hour: 21,
    durationMs: 58 * 60_000,
  },
  {
    key: 'owner-plex-b',
    personKey: 'jordan',
    serverKey: 'plex',
    daysAgo: 4,
    hour: 21.2,
    durationMs: 35 * 60_000,
    deviceKey: 'chrome',
  },
];

function buildScripted(now: Date, catalog: CatalogTitle[]): SessionRow[] {
  return SCRIPTED.map((spec, index) => {
    const random = rng(`showcase:scripted:${spec.key}`);
    const person = personById(spec.personKey);
    const playback = choosePlayback(random, catalog, spec.serverKey, spec.kind ?? 'episode');
    const startedAt = new Date(now.getTime() - spec.daysAgo * DAY_MS);
    startedAt.setUTCHours(
      Math.floor(spec.hour) - person.place.utcOffset,
      Math.round((spec.hour % 1) * 60),
      0,
      0
    );
    const device = deviceById(spec.deviceKey ?? person.devices[0] ?? 'chrome');
    const totalDurationMs = Math.max(playback.totalDurationMs, spec.durationMs);

    return {
      id: sessionIdOf(`script:${spec.key}`),
      serverKey: spec.serverKey,
      serverUserId: serverUserIdOf(person.key, spec.serverKey),
      sessionKey: `showcase-script-${index}`,
      state: 'stopped',
      mediaType: playback.mediaType,
      mediaTitle: playback.mediaTitle,
      grandparentTitle: playback.grandparentTitle,
      seasonNumber: playback.seasonNumber,
      episodeNumber: playback.episodeNumber,
      year: playback.title.spec.year,
      thumbPath: `/posters/${playback.title.spec.poster}`,
      ratingKey: playback.ratingKey,
      mediaId: playback.title.mediaId,
      showMediaId: playback.mediaType === 'episode' ? playback.title.mediaId : null,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + spec.durationMs),
      lastSeenAt: new Date(startedAt.getTime() + spec.durationMs),
      durationMs: spec.durationMs,
      totalDurationMs,
      progressMs: spec.durationMs,
      watched: spec.durationMs / totalDurationMs >= 0.85,
      place: spec.place ?? person.place,
      device,
      deviceId: `${person.slug}-${device.key}`,
      quality: QUALITY_LABEL[playback.copy.resolution] ?? '1080p',
      isTranscode: false,
      bitrate: bitrateFor(random, playback.copy.resolution, false),
      sourceResolution: playback.copy.resolution,
    };
  });
}

/** Set by seedShowcase so buildActiveSessions reports the rows it actually wrote. */
let seedAnchor: Date | null = null;
let seedAssetBaseUrl = '';

interface ActiveRow {
  row: SessionRow;
  person: ShowcasePerson;
  account: ShowcaseAccount;
}

function buildActive(now: Date, catalog: CatalogTitle[]): ActiveRow[] {
  const hdrMovie = catalog.find(
    (title) =>
      title.spec.type === 'movie' &&
      copyOn(title, 'plex')?.resolution === '4k' &&
      copyOn(title, 'plex')?.dynamicRange !== 'sdr'
  );
  const sdMovie = catalog.find(
    (title) => title.spec.type === 'movie' && copyOn(title, 'plex')?.resolution === '1080p'
  );
  const uhdShow = catalog.find(
    (title) => title.spec.type === 'show' && copyOn(title, 'jellyfin')?.resolution === '4k'
  );
  if (!hdrMovie || !sdMovie || !uhdShow) {
    throw new Error('The catalog is missing a title one of the active streams needs');
  }
  const titleFor: Record<string, CatalogTitle> = {
    'maya-4k': hdrMovie,
    'tom-transcode': uhdShow,
    'luis-paused': sdMovie,
  };

  return ACTIVE_STREAMS.map((spec, index) => {
    const random = rng(`showcase:active:${spec.key}`);
    const person = personById(spec.personKey);
    const account = person.accounts.find((entry) => entry.server === spec.serverKey);
    if (!account) throw new Error(`${person.name} has no ${spec.serverKey} account`);
    const title = titleFor[spec.key];
    const copy = title ? copyOn(title, spec.serverKey) : undefined;
    if (!title || !copy) throw new Error(`No showcase title fits the ${spec.key} stream`);
    const device = deviceById(spec.deviceKey);
    const isEpisode = spec.mediaKind === 'episode';
    const season = title.seasons[0];
    const episodeNumber = isEpisode ? 3 : null;
    const totalDurationMs = isEpisode ? title.episodeRuntimeMs : title.movieRuntimeMs;
    const progressMs = Math.round(totalDurationMs * spec.progress);

    return {
      person,
      account,
      row: {
        id: sessionIdOf(`active:${spec.key}`),
        serverKey: spec.serverKey,
        serverUserId: serverUserIdOf(person.key, spec.serverKey),
        sessionKey: `showcase-active-${index}`,
        state: spec.state,
        mediaType: isEpisode ? 'episode' : 'movie',
        mediaTitle: isEpisode ? `Episode ${episodeNumber}` : title.spec.title,
        grandparentTitle: isEpisode ? title.spec.title : null,
        seasonNumber: isEpisode ? (season?.number ?? 1) : null,
        episodeNumber,
        year: title.spec.year,
        thumbPath: `/posters/${title.spec.poster}`,
        ratingKey: isEpisode
          ? `${copy.ratingKey}-s${season?.number ?? 1}e${episodeNumber}`
          : copy.ratingKey,
        mediaId: title.mediaId,
        showMediaId: isEpisode ? title.mediaId : null,
        startedAt: new Date(now.getTime() - progressMs),
        stoppedAt: null,
        lastSeenAt: now,
        durationMs: progressMs,
        totalDurationMs,
        progressMs,
        watched: false,
        place: person.place,
        device,
        deviceId: `${person.slug}-${device.key}`,
        quality: QUALITY_LABEL[copy.resolution] ?? '1080p',
        isTranscode: spec.transcode,
        bitrate: bitrateFor(random, copy.resolution, spec.transcode),
        sourceResolution: copy.resolution,
      },
    };
  });
}

function toActiveSession(entry: ActiveRow): ActiveSession {
  const { row, person, account } = entry;
  const server = SERVERS.find((candidate) => candidate.key === row.serverKey);
  if (!server) throw new Error(`Unknown showcase server: ${row.serverKey}`);
  const [width, height] = FRAME_SIZE[row.sourceResolution] ?? [1920, 1080];
  return {
    id: row.id,
    serverId: serverIdOf(row.serverKey),
    serverUserId: row.serverUserId,
    sessionKey: row.sessionKey,
    state: row.state,
    mediaType: row.mediaType,
    mediaTitle: row.mediaTitle,
    grandparentTitle: row.grandparentTitle,
    seasonNumber: row.seasonNumber,
    episodeNumber: row.episodeNumber,
    year: row.year,
    thumbPath: row.thumbPath,
    ratingKey: row.ratingKey,
    serverVersionKey: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    mediaId: row.mediaId,
    showMediaId: row.showMediaId,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    externalSessionId: null,
    startedAt: row.startedAt,
    stoppedAt: null,
    durationMs: row.durationMs,
    totalDurationMs: row.totalDurationMs,
    progressMs: row.progressMs,
    lastPausedAt: row.state === 'paused' ? row.lastSeenAt : null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: row.place.ip,
    geoCity: row.place.city,
    geoRegion: row.place.region,
    geoCountry: row.place.country,
    geoContinent: row.place.continent,
    geoPostal: row.place.postal,
    geoLat: row.place.lat,
    geoLon: row.place.lon,
    geoAsnNumber: row.place.asnNumber,
    geoAsnOrganization: row.place.asnOrganization,
    playerName: row.device.playerName,
    deviceId: row.deviceId,
    product: row.device.product,
    device: row.device.device,
    platform: row.device.platform,
    quality: row.quality,
    isTranscode: row.isTranscode,
    videoDecision: row.isTranscode ? 'transcode' : 'directplay',
    audioDecision: row.isTranscode ? 'transcode' : 'directplay',
    bitrate: row.bitrate,
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    sourceVideoCodec: row.sourceResolution === '4k' ? 'hevc' : 'h264',
    sourceAudioCodec: row.sourceResolution === '4k' ? 'eac3' : 'aac',
    sourceAudioChannels: row.sourceResolution === '4k' ? 6 : 2,
    sourceVideoWidth: width,
    sourceVideoHeight: height,
    sourceVideoDetails: sourceVideoDetailsOf(row),
    sourceAudioDetails: {
      bitrate: 640,
      channelLayout: '5.1',
      language: 'English',
      sampleRate: 48000,
    },
    streamVideoCodec: row.isTranscode ? 'h264' : null,
    streamAudioCodec: row.isTranscode ? 'aac' : null,
    streamVideoDetails: streamVideoDetailsOf(row),
    streamAudioDetails: row.isTranscode ? { bitrate: 192, channels: 2, language: 'English' } : null,
    transcodeInfo: transcodeInfoOf(row),
    subtitleInfo: null,
    user: {
      id: row.serverUserId,
      username: account.username,
      thumbUrl: `${seedAssetBaseUrl}/avatars/${person.slug}.svg`,
      identityName: person.name,
    },
    server: { id: serverIdOf(row.serverKey), name: server.name, type: server.type },
    canTerminate: true,
  };
}

export function buildActiveSessions(ids: ShowcaseIds): ActiveSession[] {
  const now = seedAnchor ?? new Date();
  const byId = new Map(
    buildActive(now, buildCatalog(now)).map((entry) => [entry.row.id, toActiveSession(entry)])
  );
  return ids.activeSessionIds.flatMap((id) => {
    const session = byId.get(id);
    return session ? [session] : [];
  });
}

export async function writeActiveSessions(
  redisUrl: string,
  prefix: string,
  sessions: ActiveSession[]
): Promise<void> {
  const redis = new Redis(redisUrl, { keyPrefix: prefix, maxRetriesPerRequest: null });
  try {
    // KEYS takes a pattern, not a key, so ioredis leaves the prefix off it;
    // DEL does prefix its arguments, hence the slice on the way back.
    const stale = await redis.keys(`${prefix}tracearr:sessions:*`);
    const dashboard = await redis.keys(`${prefix}tracearr:stats:dashboard*`);
    const doomed = [...stale, ...dashboard].map((key) => key.slice(prefix.length));
    if (doomed.length > 0) await redis.del(...doomed);

    const pipeline = redis.multi();
    for (const session of sessions) {
      pipeline.sadd('tracearr:sessions:active:ids', session.id);
      pipeline.set(`tracearr:sessions:${session.id}`, JSON.stringify(session), 'EX', 3600);
    }
    pipeline.expire('tracearr:sessions:active:ids', 3600);
    await pipeline.exec();
  } finally {
    await redis.quit();
  }
}

async function wipe(client: Client, ownerId: string): Promise<void> {
  await client.query('DELETE FROM sessions');
  await client.query('DELETE FROM automation_runs');
  await client.query('DELETE FROM automations');
  await client.query('DELETE FROM email_suppressions');
  await client.query('DELETE FROM newsletters');
  await client.query('DELETE FROM destinations WHERE builtin = false');
  await client.query('DELETE FROM library_snapshots');
  await client.query('DELETE FROM servers');
  await client.query('DELETE FROM media');
  await client.query('DELETE FROM users WHERE id <> $1', [ownerId]);
}

async function seedPeople(client: Client, ownerId: string, assetBaseUrl: string, now: Date) {
  const avatar = (slug: string) => `${assetBaseUrl}/avatars/${slug}.svg`;

  await client.query(
    `UPDATE users
        SET name = $2, username = $3, display_username = $3, thumbnail = $4, contact_email = $5
      WHERE id = $1`,
    [ownerId, OWNER.name, OWNER.slug, avatar(OWNER.slug), OWNER.contactEmail]
  );

  await insertRows(
    client,
    'users',
    ['id', 'username', 'name', 'thumbnail', 'contact_email', 'role'],
    PEOPLE.map((person) => [
      userIdOf(person.key),
      person.slug,
      person.name,
      avatar(person.slug),
      person.contactEmail,
      'member',
    ])
  );

  const accountRows: unknown[][] = [];
  const push = (person: ShowcasePerson, userId: string) => {
    for (const account of person.accounts) {
      const joinedAt = new Date(
        now.getTime() - (120 + (hashSeed(`${person.key}:${account.server}`) % 400)) * DAY_MS
      );
      accountRows.push([
        serverUserIdOf(person.key, account.server),
        userId,
        serverIdOf(account.server),
        `${person.slug}-${account.server}`,
        account.username,
        avatar(person.slug),
        joinedAt,
        person === OWNER,
        account.trust,
        account.removedDaysAgo === undefined
          ? null
          : new Date(now.getTime() - account.removedDaysAgo * DAY_MS),
      ]);
    }
  };
  push(OWNER, ownerId);
  for (const person of PEOPLE) push(person, userIdOf(person.key));

  await insertRows(
    client,
    'server_users',
    [
      'id',
      'user_id',
      'server_id',
      'external_id',
      'username',
      'thumb_url',
      'joined_at',
      'is_server_admin',
      'trust_score',
      'removed_at',
    ],
    accountRows
  );
}

async function seedLibrary(client: Client, catalog: CatalogTitle[]): Promise<void> {
  await insertRows(
    client,
    'media',
    [
      'id',
      'media_type',
      'match_key',
      'title',
      'normalized_title',
      'sort_title',
      'year',
      'genres',
      'latest_added_at',
      'show_media_id',
      'parent_media_id',
    ],
    catalog.map((title) => [
      title.mediaId,
      title.spec.type,
      matchKeyLocal(title.spec.type, title.spec.title, title.spec.year),
      title.spec.title,
      normalizeTitleLocal(title.spec.title),
      sortTitleLocal(title.spec.title),
      title.spec.year,
      title.spec.genres,
      title.addedAt,
      null,
      null,
    ])
  );

  const itemColumns = [
    'id',
    'server_id',
    'library_id',
    'rating_key',
    'title',
    'media_type',
    'year',
    'video_resolution',
    'video_codec',
    'audio_codec',
    'audio_channels',
    'file_size',
    'video_dynamic_range',
    'media_id',
    'genres',
    'thumb_path',
    'grandparent_title',
    'grandparent_rating_key',
    'parent_title',
    'parent_rating_key',
    'parent_index',
    'item_index',
    'created_at',
    'first_seen_at',
  ];
  const items: unknown[][] = [];
  const versions: unknown[][] = [];
  // Seasons and episodes are media rows of their own, shared by every server's
  // copy and linked to the show; the shelves and episode counts join on them.
  const childMedia = new Map<string, unknown[]>();
  const childMediaId = (title: CatalogTitle, key: string) =>
    fixtureId(`showcase:media:${title.mediaId}:${key}`);
  const addChildMedia = (
    title: CatalogTitle,
    id: string,
    type: 'season' | 'episode',
    matchKey: string,
    name: string,
    parentMediaId: string | null,
    addedAt: Date
  ) => {
    if (childMedia.has(id)) return;
    childMedia.set(id, [
      id,
      type,
      matchKey,
      name,
      normalizeTitleLocal(name),
      sortTitleLocal(name),
      title.spec.year,
      title.spec.genres,
      addedAt,
      title.mediaId,
      parentMediaId,
    ]);
  };

  const addVersion = (itemId: string, copy: TitleCopy, fileSize: number, addedAt: Date) => {
    versions.push([
      fixtureId(`showcase:version:${itemId}`),
      itemId,
      'v1',
      copy.resolution,
      copy.resolution === '4k' ? 'hevc' : 'h264',
      copy.dynamicRange,
      copy.resolution === '4k' ? 'eac3' : 'aac',
      copy.resolution === '4k' ? 6 : 2,
      'mkv',
      Math.round((fileSize * 8) / 1000 / 7200),
      fileSize,
      addedAt,
    ]);
  };

  for (const title of catalog) {
    for (const copy of title.copies) {
      const poster = `/posters/${title.spec.poster}`;
      const showItemId = itemIdOf(copy.serverKey, copy.ratingKey);
      items.push([
        showItemId,
        serverIdOf(copy.serverKey),
        copy.libraryId,
        copy.ratingKey,
        title.spec.title,
        title.spec.type,
        title.spec.year,
        title.spec.type === 'movie' ? copy.resolution : null,
        title.spec.type === 'movie' ? (copy.resolution === '4k' ? 'hevc' : 'h264') : null,
        title.spec.type === 'movie' ? (copy.resolution === '4k' ? 'eac3' : 'aac') : null,
        title.spec.type === 'movie' ? (copy.resolution === '4k' ? 6 : 2) : null,
        title.spec.type === 'movie' ? copy.fileSize : null,
        title.spec.type === 'movie' ? copy.dynamicRange : null,
        title.mediaId,
        title.spec.genres,
        poster,
        null,
        null,
        null,
        null,
        null,
        null,
        title.addedAt,
        title.addedAt,
      ]);
      if (title.spec.type === 'movie') addVersion(showItemId, copy, copy.fileSize, title.addedAt);
      if (title.spec.type !== 'show') continue;

      const lastSeason = title.seasons[title.seasons.length - 1]?.number ?? 1;
      for (const season of title.seasons) {
        const seasonKey = `${copy.ratingKey}-s${season.number}`;
        const seasonId = itemIdOf(copy.serverKey, seasonKey);
        // A finale season lands inside the digest window so the newsletter has
        // new episodes for a show that has been around for months.
        const seasonAddedAt =
          season.number === lastSeason && title.index % 7 === 0
            ? new Date(Date.now() - (1 + (title.index % 4)) * DAY_MS)
            : new Date(title.addedAt.getTime() + season.number * 60 * 60 * 1000);
        const seasonMediaId = childMediaId(title, `s${season.number}`);
        addChildMedia(
          title,
          seasonMediaId,
          'season',
          `season:${title.mediaId}:s${season.number}`,
          `Season ${season.number}`,
          null,
          seasonAddedAt
        );
        items.push([
          seasonId,
          serverIdOf(copy.serverKey),
          copy.libraryId,
          seasonKey,
          `Season ${season.number}`,
          'season',
          title.spec.year,
          null,
          null,
          null,
          null,
          null,
          null,
          seasonMediaId,
          title.spec.genres,
          poster,
          title.spec.title,
          copy.ratingKey,
          null,
          copy.ratingKey,
          season.number,
          null,
          seasonAddedAt,
          seasonAddedAt,
        ]);

        for (let episode = 1; episode <= season.episodeCount; episode++) {
          const episodeKey = `${seasonKey}e${episode}`;
          const episodeId = itemIdOf(copy.serverKey, episodeKey);
          const fileSize = Math.round(
            (copy.fileSize / Math.max(season.episodeCount, 1)) * (0.9 + (episode % 5) * 0.05)
          );
          const episodeMediaId = childMediaId(title, `s${season.number}e${episode}`);
          addChildMedia(
            title,
            episodeMediaId,
            'episode',
            `episode:${title.mediaId}:s${season.number}e${episode}`,
            `Episode ${episode}`,
            seasonMediaId,
            seasonAddedAt
          );
          items.push([
            episodeId,
            serverIdOf(copy.serverKey),
            copy.libraryId,
            episodeKey,
            `Episode ${episode}`,
            'episode',
            title.spec.year,
            copy.resolution,
            copy.resolution === '4k' ? 'hevc' : 'h264',
            copy.resolution === '4k' ? 'eac3' : 'aac',
            copy.resolution === '4k' ? 6 : 2,
            fileSize,
            copy.dynamicRange,
            episodeMediaId,
            title.spec.genres,
            poster,
            title.spec.title,
            copy.ratingKey,
            `Season ${season.number}`,
            seasonKey,
            season.number,
            episode,
            seasonAddedAt,
            seasonAddedAt,
          ]);
          addVersion(episodeId, copy, fileSize, seasonAddedAt);
        }
      }
    }
  }

  await insertRows(
    client,
    'media',
    [
      'id',
      'media_type',
      'match_key',
      'title',
      'normalized_title',
      'sort_title',
      'year',
      'genres',
      'latest_added_at',
      'show_media_id',
      'parent_media_id',
    ],
    [...childMedia.values()],
    400
  );
  await insertRows(client, 'library_items', itemColumns, items, 400);
  await insertRows(
    client,
    'library_item_versions',
    [
      'id',
      'library_item_id',
      'server_version_key',
      'video_resolution',
      'video_codec',
      'video_dynamic_range',
      'audio_codec',
      'audio_channels',
      'container',
      'bitrate',
      'file_size',
      'first_seen_at',
    ],
    versions,
    400
  );
}

/**
 * Daily rollups straight off the items, so the growth chart climbs to today's
 * totals. Each row counts the library as it stood at the END of its day: a
 * snapshot that landed after the first item it counts would read as an
 * unbackfilled history and hide the Media overview (deriveLibraryStatus).
 */
async function seedSnapshots(client: Client, now: Date): Promise<void> {
  await client.query(
    `INSERT INTO library_snapshots
       (server_id, library_id, snapshot_time, item_count, total_size, movie_count,
        episode_count, season_count, show_count, music_count, count_4k, count_1080p,
        count_720p, count_sd, hevc_count, h264_count, av1_count, count_high_quality,
        version_count)
     SELECT li.server_id, li.library_id, d.day,
            count(*), coalesce(sum(li.file_size), 0),
            count(*) FILTER (WHERE li.media_type = 'movie'),
            count(*) FILTER (WHERE li.media_type = 'episode'),
            count(*) FILTER (WHERE li.media_type = 'season'),
            count(*) FILTER (WHERE li.media_type = 'show'),
            0,
            count(*) FILTER (WHERE li.video_resolution = '4k'),
            count(*) FILTER (WHERE li.video_resolution = '1080p'),
            count(*) FILTER (WHERE li.video_resolution = '720p'),
            count(*) FILTER (WHERE li.video_resolution IS NOT NULL
                             AND li.video_resolution NOT IN ('4k', '1080p', '720p')),
            count(*) FILTER (WHERE li.video_codec = 'hevc'),
            count(*) FILTER (WHERE li.video_codec = 'h264'),
            0,
            count(*) FILTER (WHERE li.video_resolution IN ('4k', '1080p')),
            count(*) FILTER (WHERE li.file_size IS NOT NULL)
       FROM generate_series(
              date_trunc('day', $1::timestamptz) - interval '89 days',
              date_trunc('day', $1::timestamptz),
              interval '1 day') AS d(day)
       JOIN library_items li
         ON li.created_at < d.day + interval '1 day' AND li.removed_at IS NULL
      GROUP BY li.server_id, li.library_id, d.day`,
    [now]
  );
}

async function refreshAggregates(client: Client): Promise<void> {
  const { rows } = await client.query<{ view_name: string }>(
    `SELECT view_name FROM timescaledb_information.continuous_aggregates
      WHERE view_name = ANY($1::text[])`,
    [
      [
        'user_media_plays_daily',
        'daily_content_engagement',
        'daily_bandwidth_by_user',
        'library_stats_daily',
        'content_quality_daily',
      ],
    ]
  );
  for (const row of rows) {
    // Not parameterizable, and the names come from the query above.
    await client.query(`CALL refresh_continuous_aggregate('${row.view_name}', NULL, NULL)`);
  }
}

/** The same rollups recomputeIdentityAggregates writes after every trust or violation change. */
async function recomputeAggregates(client: Client): Promise<void> {
  await client.query(`
    UPDATE users u
       SET aggregate_trust_score = COALESCE(a.trust, 100),
           first_joined_at = a.first_joined_at,
           last_activity_at = a.last_activity_at,
           total_violations = COALESCE(v.count, 0)
      FROM (
        SELECT su.user_id,
               COALESCE(min(su.trust_score) FILTER (WHERE su.removed_at IS NULL),
                        min(su.trust_score)) AS trust,
               min(su.joined_at) AS first_joined_at,
               max(su.last_activity_at) AS last_activity_at
          FROM server_users su GROUP BY su.user_id
      ) a
      LEFT JOIN (
        SELECT su.user_id, count(*)::int AS count
          FROM automation_runs r
          JOIN server_users su ON su.id = r.server_user_id
         WHERE r.dismissed_at IS NULL AND r.kind = 'policy' AND r.outcome = 'completed'
         GROUP BY su.user_id
      ) v ON v.user_id = a.user_id
     WHERE u.id = a.user_id
  `);
}

export async function seedShowcase(
  client: Client,
  opts: { ownerId: string; assetBaseUrl: string; now: Date }
): Promise<ShowcaseIds> {
  const { ownerId, assetBaseUrl, now } = opts;
  const catalog = buildCatalog(now);
  const history = buildHistory(now, catalog);
  const scripted = buildScripted(now, catalog);
  const active = buildActive(now, catalog);
  seedAnchor = now;
  seedAssetBaseUrl = assetBaseUrl;

  await client.query('BEGIN');
  try {
    await wipe(client, ownerId);

    await insertRows(
      client,
      'servers',
      [
        'id',
        'name',
        'type',
        'url',
        'public_url',
        'token',
        'machine_identifier',
        'color',
        'display_order',
      ],
      SERVERS.map((server, index) => [
        serverIdOf(server.key),
        server.name,
        server.type,
        assetBaseUrl,
        server.publicUrl,
        'showcase-token',
        server.machineIdentifier,
        server.color,
        index,
      ])
    );

    await insertRows(
      client,
      'libraries',
      ['id', 'server_id', 'library_id', 'name', 'media_type'],
      LIBRARIES.map((library) => [
        libraryRowIdOf(library.serverKey, library.libraryId),
        serverIdOf(library.serverKey),
        library.libraryId,
        library.name,
        library.mediaType,
      ])
    );

    await seedPeople(client, ownerId, assetBaseUrl, now);
    await seedLibrary(client, catalog);
    await seedSnapshots(client, now);

    await insertRows(
      client,
      'sessions',
      SESSION_COLUMNS,
      [...history, ...scripted, ...active.map((entry) => entry.row)].map(sessionValues),
      300
    );

    await client.query(`
      UPDATE server_users su
         SET last_activity_at = s.last_seen
        FROM (SELECT server_user_id, max(started_at) AS last_seen FROM sessions GROUP BY server_user_id) s
       WHERE s.server_user_id = su.id
    `);
    await recomputeAggregates(client);

    await client.query(
      `INSERT INTO settings (name, value) VALUES ('externalUrl', to_jsonb($1::text))
       ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
      [EXTERNAL_URL]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  await refreshAggregates(client);

  const people: ShowcaseIds['people'] = {};
  for (const person of CAST) {
    const serverUserIds: Partial<Record<ServerKey, string>> = {};
    for (const account of person.accounts) {
      serverUserIds[account.server] = serverUserIdOf(person.key, account.server);
    }
    people[person.key] = {
      userId: person === OWNER ? ownerId : userIdOf(person.key),
      serverUserIds,
    };
  }

  return {
    servers: {
      plex: serverIdOf('plex'),
      jellyfin: serverIdOf('jellyfin'),
      emby: serverIdOf('emby'),
    },
    ownerServerUserIds: OWNER.accounts.map((account) => serverUserIdOf(OWNER.key, account.server)),
    people,
    activeSessionIds: active.map((entry) => entry.row.id),
    featuredMovieMediaId: featuredMovie(catalog).mediaId,
    featuredMovieTitle: featuredMovie(catalog).spec.title,
    libraryIds: Object.fromEntries(
      LIBRARIES.map((library) => [
        `${library.serverKey}:${library.libraryId}`,
        libraryRowIdOf(library.serverKey, library.libraryId),
      ])
    ),
  };
}

/** An optional input nothing bound; the key it sits under drops out of the definition. */
const DROP = Symbol('unbound');

/** Mirrors materializeTemplate's walker: bound inputs replace their placeholder, unbound optional ones drop the key. */
function materialize(node: unknown, bound: Record<string, unknown>): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    const entries = Object.entries(node as Record<string, unknown>);
    const placeholder = entries.length === 1 && entries[0]?.[0] === '$input' ? entries[0] : null;
    if (placeholder) {
      const key = placeholder[1];
      return typeof key === 'string' && key in bound ? bound[key] : DROP;
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      const resolved = materialize(value, bound);
      if (resolved !== DROP) out[key] = resolved;
    }
    return out;
  }
  if (Array.isArray(node)) {
    return node.map((item) => materialize(item, bound)).filter((item) => item !== DROP);
  }
  return node;
}

interface TemplateVersion {
  templateId: string;
  version: number;
  inputs: { key: string; default?: unknown }[];
  definition: Record<string, unknown>;
}

async function loadTemplate(client: Client, slug: string): Promise<TemplateVersion> {
  const { rows } = await client.query<{
    template_id: string;
    version: number;
    inputs: { key: string; default?: unknown }[];
    definition: Record<string, unknown>;
  }>(
    `SELECT t.id AS template_id, v.version, v.inputs, v.definition
       FROM automation_templates t
       JOIN automation_template_versions v ON v.template_id = t.id
      WHERE t.slug = $1
      ORDER BY v.version DESC
      LIMIT 1`,
    [slug]
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `Template "${slug}" is not in the database. Boot the server against this database once so it seeds the built-ins.`
    );
  }
  return {
    templateId: row.template_id,
    version: row.version,
    inputs: row.inputs,
    definition: row.definition,
  };
}

const automationIdOf = (slug: string): string => fixtureId(`showcase:automation:${slug}`);
const automationVersionIdOf = (slug: string): string =>
  fixtureId(`showcase:automation-version:${slug}`);
const runIdOf = (key: string): string => fixtureId(`showcase:run:${key}`);

interface RunSpec {
  key: string;
  slug: string;
  personKey: string;
  serverKey: ServerKey;
  sessionKey: string;
  relatedSessionKey: string | null;
  daysAgo: number;
  acknowledged?: boolean;
  dismissed?: boolean;
  evidence: Record<string, unknown>[];
}

function evidenceGroup(
  groupIndex: number,
  conditions: Record<string, unknown>[]
): Record<string, unknown> {
  return { groupIndex, matched: true, match: 'all', conditions };
}

function geoEvidence(country: string): Record<string, unknown>[] {
  return [
    evidenceGroup(0, [
      {
        field: 'country',
        operator: 'in',
        threshold: ['BR', 'RU', 'CN'],
        actual: country,
        matched: true,
      },
    ]),
    evidenceGroup(1, [
      { field: 'is_local_network', operator: 'eq', threshold: false, actual: false, matched: true },
    ]),
  ];
}

function travelEvidence(
  sessionId: string,
  from: ShowcasePlace,
  to: ShowcasePlace
): Record<string, unknown>[] {
  return [
    evidenceGroup(0, [
      {
        field: 'travel_speed_kmh',
        operator: 'gt',
        threshold: 500,
        actual: 6420,
        matched: true,
        relatedSessionIds: [sessionId],
        details: {
          distance: 9630,
          previousLocation: { city: from.city, country: from.country },
          currentLocation: { city: to.city, country: to.country },
        },
      },
    ]),
  ];
}

function concurrentEvidence(sessionId: string, actual: number): Record<string, unknown>[] {
  return [
    evidenceGroup(0, [
      {
        field: 'concurrent_streams',
        operator: 'gt',
        threshold: 2,
        actual,
        matched: true,
        relatedSessionIds: [sessionId],
      },
    ]),
  ];
}

const RUNS: RunSpec[] = [
  {
    key: 'concurrent-maya-1',
    slug: 'concurrent-streams',
    personKey: 'maya',
    serverKey: 'jellyfin',
    sessionKey: 'maya-jf-1b',
    relatedSessionKey: 'maya-jf-1a',
    daysAgo: 27,
    acknowledged: true,
    evidence: concurrentEvidence(sessionIdOf('script:maya-jf-1a'), 3),
  },
  {
    key: 'concurrent-maya-2',
    slug: 'concurrent-streams',
    personKey: 'maya',
    serverKey: 'jellyfin',
    sessionKey: 'maya-jf-2b',
    relatedSessionKey: 'maya-jf-2a',
    daysAgo: 6,
    evidence: concurrentEvidence(sessionIdOf('script:maya-jf-2a'), 3),
  },
  {
    key: 'concurrent-daniel',
    slug: 'concurrent-streams',
    personKey: 'daniel',
    serverKey: 'emby',
    sessionKey: 'daniel-emby-b',
    relatedSessionKey: 'daniel-emby-a',
    daysAgo: 12,
    evidence: concurrentEvidence(sessionIdOf('script:daniel-emby-a'), 3),
  },
  {
    key: 'geo-tom-1',
    slug: 'geo-restriction',
    personKey: 'tom',
    serverKey: 'plex',
    sessionKey: 'tom-sao-paulo-1',
    relatedSessionKey: null,
    daysAgo: 23,
    acknowledged: true,
    evidence: geoEvidence('BR'),
  },
  {
    key: 'geo-tom-2',
    slug: 'geo-restriction',
    personKey: 'tom',
    serverKey: 'plex',
    sessionKey: 'tom-sao-paulo-2',
    relatedSessionKey: null,
    daysAgo: 9,
    evidence: geoEvidence('BR'),
  },
  {
    key: 'geo-kenji',
    slug: 'geo-restriction',
    personKey: 'kenji',
    serverKey: 'jellyfin',
    sessionKey: 'kenji-shanghai',
    relatedSessionKey: null,
    daysAgo: 16,
    evidence: geoEvidence('CN'),
  },
  {
    key: 'travel-tom-1',
    slug: 'impossible-travel',
    personKey: 'tom',
    serverKey: 'plex',
    sessionKey: 'tom-sao-paulo-1',
    relatedSessionKey: 'tom-berlin-1',
    daysAgo: 23,
    evidence: travelEvidence(
      sessionIdOf('script:tom-berlin-1'),
      personById('tom').place,
      SAO_PAULO
    ),
  },
  {
    key: 'travel-tom-2',
    slug: 'impossible-travel',
    personKey: 'tom',
    serverKey: 'plex',
    sessionKey: 'tom-sao-paulo-2',
    relatedSessionKey: 'tom-berlin-2',
    daysAgo: 9,
    evidence: travelEvidence(
      sessionIdOf('script:tom-berlin-2'),
      personById('tom').place,
      SAO_PAULO
    ),
  },
  {
    key: 'concurrent-owner',
    slug: 'concurrent-streams',
    personKey: 'jordan',
    serverKey: 'plex',
    sessionKey: 'owner-plex-b',
    relatedSessionKey: 'owner-plex-a',
    daysAgo: 4,
    dismissed: true,
    evidence: concurrentEvidence(sessionIdOf('script:owner-plex-a'), 3),
  },
];

const RUN_COLUMNS = [
  'id',
  'rule_id',
  'server_user_id',
  'session_id',
  'severity',
  'server_id',
  'data',
  'kind',
  'outcome',
  'definition_version_id',
  'steps',
  'subject_key',
  'started_at',
  'finished_at',
  'created_at',
  'acknowledged_at',
  'dismissed_at',
];

export async function seedAutomations(
  client: Client,
  ids: ShowcaseIds,
  destinations: { discord: string; email: string }
): Promise<Record<string, string>> {
  const now = seedAnchor ?? new Date();
  const automations: unknown[][] = [];
  const versions: unknown[][] = [];
  const bySlug: Record<string, string> = {};

  for (const spec of AUTOMATIONS) {
    const template = await loadTemplate(client, spec.slug);
    const bound: Record<string, unknown> = { ...spec.inputs };
    for (const input of template.inputs) {
      if (!(input.key in bound) && input.default !== undefined) bound[input.key] = input.default;
    }
    if (spec.destination) bound.to = [destinations[spec.destination]];

    const definition = materialize(template.definition, bound) as Record<string, unknown>;
    const kind = definition.kind as string;
    const scope = (definition.scope ?? {}) as Record<string, unknown>;
    const automationId = automationIdOf(spec.slug);
    const severity = kind === 'notification' ? null : spec.severity;

    automations.push([
      automationId,
      spec.name,
      kind,
      JSON.stringify(definition.triggers ?? []),
      JSON.stringify(definition.conditions ?? { groups: [] }),
      JSON.stringify(definition.actions ?? { actions: [] }),
      spec.severity,
      scope.serverId ?? null,
      template.templateId,
      template.version,
      JSON.stringify(bound),
      true,
    ]);

    versions.push([
      automationVersionIdOf(spec.slug),
      automationId,
      1,
      JSON.stringify({
        name: spec.name,
        kind,
        severity,
        triggers: definition.triggers ?? [],
        conditions: definition.conditions ?? null,
        actions: definition.actions ?? { actions: [] },
        serverId: scope.serverId ?? null,
        serverUserId: null,
        userId: null,
        enforceAcrossServers: false,
      }),
    ]);
    bySlug[spec.slug] = automationId;
  }

  await insertRows(
    client,
    'automations',
    [
      'id',
      'name',
      'kind',
      'triggers',
      'conditions',
      'actions',
      'severity',
      'server_id',
      'template_id',
      'template_version',
      'template_inputs',
      'is_active',
    ],
    automations
  );
  await insertRows(
    client,
    'automation_versions',
    ['id', 'automation_id', 'version', 'definition'],
    versions
  );

  const specBySlug = new Map(AUTOMATIONS.map((entry) => [entry.slug, entry]));
  const runs: unknown[][] = RUNS.map((spec) => {
    const sessionId = sessionIdOf(`script:${spec.sessionKey}`);
    const at = new Date(now.getTime() - spec.daysAgo * DAY_MS + 40 * 60_000);
    const automation = specBySlug.get(spec.slug);
    const serverUserId = ids.people[spec.personKey]?.serverUserIds[spec.serverKey] ?? null;
    // The partner stream rides along so the violation page can table both.
    const related =
      spec.relatedSessionKey === null ? [] : [sessionIdOf(`script:${spec.relatedSessionKey}`)];
    return [
      runIdOf(spec.key),
      automationIdOf(spec.slug),
      serverUserId,
      sessionId,
      automation?.severity ?? 'warning',
      ids.servers[spec.serverKey],
      JSON.stringify({
        evidence: spec.evidence,
        relatedSessionIds: [sessionId, ...related],
        ruleName: automation?.name ?? spec.slug,
        matchedGroups: [],
        triggerId: null,
        edgeKey: 'showcase',
      }),
      'policy',
      'completed',
      automationVersionIdOf(spec.slug),
      JSON.stringify([
        {
          trigger: { id: null, type: 'session.started', edgeKey: 'showcase' },
          sessionId,
          serverId: ids.servers[spec.serverKey],
          serverUserId,
        },
      ]),
      sessionId,
      new Date(at.getTime() - 900),
      at,
      at,
      spec.acknowledged ? new Date(at.getTime() + 6 * 60 * 60 * 1000) : null,
      spec.dismissed ? new Date(at.getTime() + 2 * 60 * 60 * 1000) : null,
    ];
  });

  const { rows: recentItems } = await client.query<{
    id: string;
    title: string;
    server_id: string;
  }>(
    `SELECT id, title, server_id FROM library_items
      WHERE media_type = 'movie' AND removed_at IS NULL
      ORDER BY created_at DESC LIMIT 3`
  );

  const deviceRuns: {
    key: string;
    personKey: string;
    serverKey: ServerKey;
    deviceKey: string;
    daysAgo: number;
  }[] = [
    { key: 'device-maya', personKey: 'maya', serverKey: 'plex', deviceKey: 'iphone', daysAgo: 11 },
    {
      key: 'device-priya',
      personKey: 'priya',
      serverKey: 'jellyfin',
      deviceKey: 'swiftfin',
      daysAgo: 7,
    },
    { key: 'device-grace', personKey: 'grace', serverKey: 'emby', deviceKey: 'firetv', daysAgo: 3 },
  ];

  for (const spec of deviceRuns) {
    const at = new Date(now.getTime() - spec.daysAgo * DAY_MS);
    const person = personById(spec.personKey);
    const serverUserId = ids.people[spec.personKey]?.serverUserIds[spec.serverKey] ?? null;
    const edgeKey = `${person.slug}-${spec.deviceKey}`;
    runs.push([
      runIdOf(spec.key),
      automationIdOf('new-device'),
      serverUserId,
      null,
      null,
      ids.servers[spec.serverKey],
      JSON.stringify({
        evidence: [],
        relatedSessionIds: [],
        ruleName: 'New device',
        matchedGroups: [],
        triggerId: null,
        edgeKey,
      }),
      'notification',
      'completed',
      automationVersionIdOf('new-device'),
      JSON.stringify([
        {
          trigger: { id: null, type: 'account.new_device', edgeKey },
          sessionId: null,
          serverId: ids.servers[spec.serverKey],
          serverUserId,
        },
        { action: 'send', success: true },
      ]),
      serverUserId,
      new Date(at.getTime() - 400),
      at,
      at,
      null,
      null,
    ]);
  }

  recentItems.forEach((item, index) => {
    const at = new Date(now.getTime() - (index + 1) * DAY_MS);
    runs.push([
      runIdOf(`media-added-${index}`),
      automationIdOf('media-added'),
      null,
      null,
      null,
      item.server_id,
      JSON.stringify({
        evidence: [],
        relatedSessionIds: [],
        ruleName: 'New on the server',
        matchedGroups: [],
        triggerId: null,
        edgeKey: item.id,
      }),
      'notification',
      'completed',
      automationVersionIdOf('media-added'),
      JSON.stringify([
        {
          trigger: { id: null, type: 'media.added', edgeKey: item.id },
          sessionId: null,
          serverId: item.server_id,
          serverUserId: null,
        },
        { action: 'send', success: true },
      ]),
      `media:${item.id}`,
      new Date(at.getTime() - 400),
      at,
      at,
      null,
      null,
    ]);
  });

  await insertRows(client, 'automation_runs', RUN_COLUMNS, runs);
  await recomputeAggregates(client);
  return bySlug;
}

export async function seedNewsletterSend(
  client: Client,
  input: {
    newsletterId: string;
    destinationId: string;
    subject: string;
    html: string;
    text: string;
    recipients: { address: string; userId: string | null }[];
    now: Date;
  }
): Promise<string> {
  const sendId = fixtureId('showcase:newsletter-send');
  const finishedAt = new Date(input.now.getTime() - DAY_MS);
  const startedAt = new Date(finishedAt.getTime() - 42_000);
  const windowEnd = finishedAt;
  const windowStart = new Date(windowEnd.getTime() - 7 * DAY_MS);
  const serverIds = [serverIdOf('plex'), serverIdOf('jellyfin')];
  const key = variantKey(serverIds);

  const { rows } = await client.query<{ movies: string; shows: string; episodes: string }>(
    `SELECT count(*) FILTER (WHERE media_type = 'movie') AS movies,
            count(DISTINCT grandparent_rating_key) FILTER (WHERE media_type = 'episode') AS shows,
            count(*) FILTER (WHERE media_type = 'episode') AS episodes
       FROM library_items
      WHERE removed_at IS NULL
        AND server_id = ANY($1::uuid[])
        AND COALESCE(first_seen_at, created_at) >= $2
        AND COALESCE(first_seen_at, created_at) < $3`,
    [serverIds, windowStart, windowEnd]
  );
  const counts = {
    movies: Number(rows[0]?.movies ?? 0),
    shows: Number(rows[0]?.shows ?? 0),
    episodes: Number(rows[0]?.episodes ?? 0),
    albums: 0,
    mostWatched: 5,
  };

  await client.query('DELETE FROM newsletter_sends WHERE newsletter_id = $1', [input.newsletterId]);
  await client.query(
    `INSERT INTO newsletter_sends
       (id, newsletter_id, destination_id, trigger, window_start, window_end, item_counts,
        recipient_count, outcome, variants, started_at, finished_at)
     VALUES ($1, $2, $3, 'schedule', $4, $5, $6, $7, 'sent', $8, $9, $10)`,
    [
      sendId,
      input.newsletterId,
      input.destinationId,
      windowStart,
      windowEnd,
      JSON.stringify(counts),
      input.recipients.length,
      JSON.stringify([
        {
          key,
          serverIds,
          serverNames: ['Plex', 'Jellyfin'],
          recipientCount: input.recipients.length,
          trimmed: { movies: 0, shows: 0, albums: 0, mostWatched: 0 },
          bytes: Buffer.byteLength(input.html, 'utf8'),
          empty: false,
        },
      ]),
      startedAt,
      finishedAt,
    ]
  );

  await client.query(
    `INSERT INTO newsletter_send_snapshots (send_id, variant_key, view_token, subject, html, text, posters)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`,
    [
      sendId,
      key,
      fixtureId('showcase:newsletter-view-token'),
      input.subject,
      input.html,
      input.text,
    ]
  );

  await insertRows(
    client,
    'newsletter_send_recipients',
    [
      'id',
      'send_id',
      'address',
      'user_id',
      'variant_key',
      'status',
      'attempts',
      'error',
      'message_id',
      'sent_at',
    ],
    input.recipients.map((recipient, index) => {
      const failed = index === input.recipients.length - 1;
      return [
        fixtureId(`showcase:newsletter-recipient:${recipient.address}`),
        sendId,
        recipient.address,
        recipient.userId,
        key,
        failed ? 'failed' : 'sent',
        failed ? 3 : 1,
        failed ? '550 mailbox unavailable' : null,
        failed ? null : `<${fixtureId(`showcase:message:${recipient.address}`)}@example.com>`,
        failed ? null : finishedAt,
      ];
    })
  );

  return sendId;
}
