/**
 * The fixed showcase cast. Everything here is deterministic: the same values
 * on every run, so a re-capture only differs where the UI itself changed.
 * seed.ts turns this into rows; assetServer.ts serves the posters and avatars
 * these paths point at.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type ServerKey = 'plex' | 'jellyfin' | 'emby';

export interface ShowcaseServer {
  key: ServerKey;
  name: string;
  type: ServerKey;
  color: string;
  /** Where members open the server themselves; Plex links through app.plex.tv instead. */
  publicUrl: string | null;
  machineIdentifier: string;
}

export const SERVERS: ShowcaseServer[] = [
  {
    key: 'plex',
    name: 'Plex',
    type: 'plex',
    color: '#e5a00d',
    publicUrl: null,
    machineIdentifier: 'showcase-plex-machine',
  },
  {
    key: 'jellyfin',
    name: 'Jellyfin',
    type: 'jellyfin',
    color: '#aa5cc3',
    publicUrl: 'https://jellyfin.example.com',
    machineIdentifier: 'showcase-jellyfin-machine',
  },
  {
    key: 'emby',
    name: 'Emby',
    type: 'emby',
    color: '#52b54b',
    publicUrl: 'https://emby.example.com',
    machineIdentifier: 'showcase-emby-machine',
  },
];

export interface ShowcaseLibrary {
  serverKey: ServerKey;
  /** The media server's own library id, as library_items.library_id carries it. */
  libraryId: string;
  name: string;
  mediaType: string;
}

export const LIBRARIES: ShowcaseLibrary[] = [
  { serverKey: 'plex', libraryId: 'movies', name: 'Movies', mediaType: 'movie' },
  { serverKey: 'plex', libraryId: 'tv', name: 'TV Shows', mediaType: 'show' },
  { serverKey: 'plex', libraryId: 'music', name: 'Music', mediaType: 'artist' },
  { serverKey: 'jellyfin', libraryId: 'movies', name: 'Movies', mediaType: 'movie' },
  { serverKey: 'jellyfin', libraryId: 'tv', name: 'TV Shows', mediaType: 'show' },
  { serverKey: 'emby', libraryId: 'movies', name: 'Movies', mediaType: 'movie' },
  { serverKey: 'emby', libraryId: 'tv', name: 'TV Shows', mediaType: 'show' },
];

export interface ShowcaseDevice {
  key: string;
  product: string;
  device: string;
  platform: string;
  playerName: string;
}

export const DEVICES: Record<string, ShowcaseDevice> = {
  appletv: {
    key: 'appletv',
    product: 'Plex for Apple TV',
    device: 'Apple TV',
    platform: 'tvOS',
    playerName: 'Living Room',
  },
  roku: {
    key: 'roku',
    product: 'Plex for Roku',
    device: 'Roku Ultra',
    platform: 'Roku',
    playerName: 'Bedroom',
  },
  chrome: {
    key: 'chrome',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Chrome',
    playerName: 'Chrome',
  },
  iphone: {
    key: 'iphone',
    product: 'Plex for iOS',
    device: 'iPhone 15',
    platform: 'iOS',
    playerName: 'iPhone',
  },
  jmp: {
    key: 'jmp',
    product: 'Jellyfin Media Player',
    device: 'Windows',
    platform: 'Windows',
    playerName: 'Desk PC',
  },
  shield: {
    key: 'shield',
    product: 'Jellyfin for Android TV',
    device: 'SHIELD',
    platform: 'Android',
    playerName: 'Den',
  },
  infuse: {
    key: 'infuse',
    product: 'Infuse',
    device: 'Apple TV',
    platform: 'tvOS',
    playerName: 'Loft',
  },
  firetv: {
    key: 'firetv',
    product: 'Emby for Fire TV',
    device: 'Fire TV Stick 4K',
    platform: 'Fire OS',
    playerName: 'Kitchen',
  },
  swiftfin: {
    key: 'swiftfin',
    product: 'Swiftfin',
    device: 'iPad',
    platform: 'iPadOS',
    playerName: 'iPad',
  },
};

export interface ShowcasePlace {
  city: string;
  region: string | null;
  country: string;
  continent: string;
  postal: string | null;
  lat: number;
  lon: number;
  asnNumber: number | null;
  asnOrganization: string | null;
  ip: string;
  /** Hours ahead of UTC, so evening sessions land in the person's own evening. */
  utcOffset: number;
}

export interface ShowcaseAccount {
  server: ServerKey;
  username: string;
  trust: number;
  removedDaysAgo?: number;
}

export interface ShowcasePerson {
  key: string;
  name: string;
  /** Identity username and the avatar slug the asset server draws initials for. */
  slug: string;
  place: ShowcasePlace;
  accounts: ShowcaseAccount[];
  devices: string[];
  contactEmail: string | null;
  /** Relative share of the generated session history. */
  weight: number;
}

export const OWNER: ShowcasePerson = {
  key: 'jordan',
  name: 'Jordan Wells',
  slug: 'jordan',
  place: {
    city: 'Denver',
    region: 'CO',
    country: 'US',
    continent: 'North America',
    postal: '80202',
    lat: 39.7392,
    lon: -104.9903,
    asnNumber: null,
    asnOrganization: null,
    ip: '192.168.1.24',
    utcOffset: -6,
  },
  accounts: [
    { server: 'plex', username: 'jordan', trust: 100 },
    { server: 'jellyfin', username: 'jordan', trust: 100 },
    { server: 'emby', username: 'jordan', trust: 100 },
  ],
  devices: ['appletv', 'chrome'],
  contactEmail: 'jordan@example.com',
  weight: 14,
};

export const PEOPLE: ShowcasePerson[] = [
  {
    key: 'maya',
    name: 'Maya Chen',
    slug: 'maya',
    place: {
      city: 'Seattle',
      region: 'WA',
      country: 'US',
      continent: 'North America',
      postal: '98101',
      lat: 47.6062,
      lon: -122.3321,
      asnNumber: 7922,
      asnOrganization: 'Comcast Cable',
      ip: '73.109.42.17',
      utcOffset: -7,
    },
    accounts: [
      { server: 'plex', username: 'mayac', trust: 100 },
      { server: 'jellyfin', username: 'maya.chen', trust: 72 },
      { server: 'emby', username: 'mayachen', trust: 88 },
    ],
    devices: ['appletv', 'iphone'],
    contactEmail: 'maya@example.com',
    weight: 16,
  },
  {
    key: 'luis',
    name: 'Luis Ortega',
    slug: 'luis',
    place: {
      city: 'Austin',
      region: 'TX',
      country: 'US',
      continent: 'North America',
      postal: '78701',
      lat: 30.2672,
      lon: -97.7431,
      asnNumber: 20115,
      asnOrganization: 'Charter Communications',
      ip: '24.28.116.9',
      utcOffset: -5,
    },
    accounts: [{ server: 'plex', username: 'lortega', trust: 100 }],
    devices: ['iphone', 'roku'],
    contactEmail: 'luis@example.com',
    weight: 12,
  },
  {
    // Same username on another server under its own identity: this is the pair
    // the merge suggestion on /users is built from.
    key: 'luis2',
    name: 'Luis Ortega',
    slug: 'luis2',
    place: {
      city: 'Austin',
      region: 'TX',
      country: 'US',
      continent: 'North America',
      postal: '78701',
      lat: 30.2672,
      lon: -97.7431,
      asnNumber: 20115,
      asnOrganization: 'Charter Communications',
      ip: '24.28.116.41',
      utcOffset: -5,
    },
    accounts: [{ server: 'jellyfin', username: 'lortega', trust: 100 }],
    devices: ['jmp'],
    contactEmail: null,
    weight: 5,
  },
  {
    key: 'priya',
    name: 'Priya Nair',
    slug: 'priya',
    place: {
      city: 'Toronto',
      region: 'ON',
      country: 'CA',
      continent: 'North America',
      postal: 'M5H',
      lat: 43.6532,
      lon: -79.3832,
      asnNumber: 812,
      asnOrganization: 'Rogers Communications',
      ip: '99.229.14.88',
      utcOffset: -4,
    },
    accounts: [
      { server: 'plex', username: 'priyan', trust: 96 },
      { server: 'jellyfin', username: 'priya', trust: 96 },
    ],
    devices: ['roku', 'swiftfin'],
    contactEmail: 'priya@example.com',
    weight: 13,
  },
  {
    key: 'tom',
    name: 'Tom Becker',
    slug: 'tom',
    place: {
      city: 'Berlin',
      region: 'Berlin',
      country: 'DE',
      continent: 'Europe',
      postal: '10117',
      lat: 52.52,
      lon: 13.405,
      asnNumber: 3320,
      asnOrganization: 'Deutsche Telekom',
      ip: '87.138.55.23',
      utcOffset: 2,
    },
    accounts: [
      { server: 'plex', username: 'tbecker', trust: 64 },
      { server: 'jellyfin', username: 'tom.becker', trust: 78 },
    ],
    devices: ['chrome', 'jmp'],
    contactEmail: 'tom@example.com',
    weight: 10,
  },
  {
    key: 'aisha',
    name: 'Aisha Bello',
    slug: 'aisha',
    place: {
      city: 'London',
      region: 'England',
      country: 'GB',
      continent: 'Europe',
      postal: 'EC1A',
      lat: 51.5072,
      lon: -0.1276,
      asnNumber: 2856,
      asnOrganization: 'British Telecommunications',
      ip: '81.132.9.144',
      utcOffset: 1,
    },
    accounts: [{ server: 'emby', username: 'aisha', trust: 100 }],
    devices: ['firetv'],
    contactEmail: 'aisha@example.com',
    weight: 9,
  },
  {
    key: 'kenji',
    name: 'Kenji Sato',
    slug: 'kenji',
    place: {
      city: 'Tokyo',
      region: 'Tokyo',
      country: 'JP',
      continent: 'Asia',
      postal: '100-0001',
      lat: 35.6762,
      lon: 139.6503,
      asnNumber: 4713,
      asnOrganization: 'NTT Communications',
      ip: '126.72.18.55',
      utcOffset: 9,
    },
    accounts: [{ server: 'jellyfin', username: 'kenji', trust: 92 }],
    devices: ['shield'],
    contactEmail: 'kenji@example.com',
    weight: 9,
  },
  {
    key: 'sofia',
    name: 'Sofia Rossi',
    slug: 'sofia',
    place: {
      city: 'Milan',
      region: 'Lombardy',
      country: 'IT',
      continent: 'Europe',
      postal: '20121',
      lat: 45.4642,
      lon: 9.19,
      asnNumber: 30722,
      asnOrganization: 'Vodafone Italia',
      ip: '79.44.201.6',
      utcOffset: 2,
    },
    accounts: [{ server: 'plex', username: 'sofiar', trust: 100 }],
    devices: ['appletv'],
    contactEmail: 'sofia@example.com',
    weight: 8,
  },
  {
    key: 'daniel',
    name: 'Daniel Kim',
    slug: 'daniel',
    place: {
      city: 'Los Angeles',
      region: 'CA',
      country: 'US',
      continent: 'North America',
      postal: '90012',
      lat: 34.0522,
      lon: -118.2437,
      asnNumber: 20115,
      asnOrganization: 'Charter Communications',
      ip: '76.90.183.204',
      utcOffset: -7,
    },
    accounts: [
      { server: 'plex', username: 'dkim', trust: 81 },
      { server: 'emby', username: 'daniel', trust: 94 },
    ],
    devices: ['chrome', 'firetv'],
    contactEmail: 'daniel@example.com',
    weight: 11,
  },
  {
    key: 'emma',
    name: 'Emma Laurent',
    slug: 'emma',
    place: {
      city: 'Paris',
      region: 'Ile-de-France',
      country: 'FR',
      continent: 'Europe',
      postal: '75001',
      lat: 48.8566,
      lon: 2.3522,
      asnNumber: 3215,
      asnOrganization: 'Orange',
      ip: '90.63.77.12',
      utcOffset: 2,
    },
    accounts: [{ server: 'jellyfin', username: 'emmal', trust: 100 }],
    devices: ['jmp', 'swiftfin'],
    contactEmail: null,
    weight: 8,
  },
  {
    key: 'noah',
    name: 'Noah Fischer',
    slug: 'noah',
    place: {
      city: 'Chicago',
      region: 'IL',
      country: 'US',
      continent: 'North America',
      postal: '60601',
      lat: 41.8781,
      lon: -87.6298,
      asnNumber: 7018,
      asnOrganization: 'AT&T Internet',
      ip: '68.203.16.72',
      utcOffset: -5,
    },
    accounts: [{ server: 'plex', username: 'noahf', trust: 100, removedDaysAgo: 20 }],
    devices: ['roku'],
    contactEmail: null,
    weight: 6,
  },
  {
    key: 'grace',
    name: 'Grace Okoro',
    slug: 'grace',
    place: {
      city: 'Lagos',
      region: 'Lagos',
      country: 'NG',
      continent: 'Africa',
      postal: '100001',
      lat: 6.5244,
      lon: 3.3792,
      asnNumber: 29465,
      asnOrganization: 'MTN Nigeria',
      ip: '41.184.22.90',
      utcOffset: 1,
    },
    accounts: [{ server: 'emby', username: 'grace', trust: 100 }],
    devices: ['firetv'],
    contactEmail: null,
    weight: 7,
  },
];

export const CAST: ShowcasePerson[] = [OWNER, ...PEOPLE];

/** Where a session came from when it did not come from the person's own city. */
export const SAO_PAULO: ShowcasePlace = {
  city: 'Sao Paulo',
  region: 'Sao Paulo',
  country: 'BR',
  continent: 'South America',
  postal: '01000',
  lat: -23.5505,
  lon: -46.6333,
  asnNumber: 26599,
  asnOrganization: 'Telefonica Brasil',
  ip: '189.4.77.201',
  utcOffset: -3,
};

export const SHANGHAI: ShowcasePlace = {
  city: 'Shanghai',
  region: 'Shanghai',
  country: 'CN',
  continent: 'Asia',
  postal: '200000',
  lat: 31.2304,
  lon: 121.4737,
  asnNumber: 4812,
  asnOrganization: 'China Telecom',
  ip: '116.226.44.3',
  utcOffset: 8,
};

export interface ShowcaseTitle {
  type: 'movie' | 'show';
  title: string;
  year: number;
  genres: string[];
  resolution: string | null;
  dynamicRange: string | null;
  fileSize: number | null;
  poster: string;
}

/** Written by showcase/exportFromDev.mjs; git-ignored, so its absence is a setup step, not a bug. */
export function loadTitles(): ShowcaseTitle[] {
  const file = resolve(import.meta.dirname, 'assets/titles.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ShowcaseTitle[];
  } catch {
    throw new Error(
      `${file} is missing. Run "node apps/e2e/showcase/exportFromDev.mjs" against a real install first.`
    );
  }
}

export interface ActiveStreamSpec {
  key: string;
  personKey: string;
  serverKey: ServerKey;
  deviceKey: string;
  mediaKind: 'movie' | 'episode';
  state: 'playing' | 'paused';
  /** How far into the item the stream sits. */
  progress: number;
  transcode: boolean;
}

export const ACTIVE_STREAMS: ActiveStreamSpec[] = [
  {
    key: 'maya-4k',
    personKey: 'maya',
    serverKey: 'plex',
    deviceKey: 'appletv',
    mediaKind: 'movie',
    state: 'playing',
    progress: 0.38,
    transcode: false,
  },
  {
    key: 'tom-transcode',
    personKey: 'tom',
    serverKey: 'jellyfin',
    deviceKey: 'chrome',
    mediaKind: 'episode',
    state: 'playing',
    progress: 0.12,
    transcode: true,
  },
  {
    key: 'luis-paused',
    personKey: 'luis',
    serverKey: 'plex',
    deviceKey: 'iphone',
    mediaKind: 'movie',
    state: 'paused',
    progress: 0.61,
    transcode: false,
  },
];

export interface AutomationSpec {
  /** Template slug; the seed looks up the highest version of it. */
  slug: string;
  name: string;
  severity: 'low' | 'warning' | 'high';
  /** Inputs bound by value; 'discord' and 'email' stand in for destination ids. */
  inputs: Record<string, unknown>;
  destination?: 'discord' | 'email';
}

export const AUTOMATIONS: AutomationSpec[] = [
  {
    slug: 'concurrent-streams',
    name: 'Too many streams at once',
    severity: 'high',
    inputs: { max: 2 },
  },
  {
    slug: 'geo-restriction',
    name: 'Blocked countries',
    severity: 'warning',
    inputs: { countries: ['BR', 'RU', 'CN'], ignoreLan: true },
  },
  {
    slug: 'impossible-travel',
    name: 'Impossible travel',
    severity: 'high',
    inputs: {},
  },
  {
    slug: 'new-device',
    name: 'New device',
    severity: 'warning',
    inputs: {},
    destination: 'discord',
  },
  {
    slug: 'server-down',
    name: 'Server down',
    severity: 'warning',
    inputs: {},
    destination: 'email',
  },
  {
    slug: 'media-added',
    name: 'New on the server',
    severity: 'warning',
    inputs: {},
    destination: 'discord',
  },
  {
    slug: 'kill-paused-streams',
    name: 'Kill paused streams',
    severity: 'low',
    inputs: {},
  },
];

export const EXTERNAL_URL = 'https://tracearr.example.com';

/** Deterministic 32-bit hash; seeds the generators so a rerun repeats itself. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32, seeded by string. */
export function rng(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function intBetween(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick() called with an empty list');
  return item;
}

/** Picks by weight, so the busy people stay busy across every table. */
export function pickWeighted<T>(
  random: () => number,
  items: readonly T[],
  weight: (item: T) => number
): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= weight(item);
    if (roll <= 0) return item;
  }
  const last = items[items.length - 1];
  if (last === undefined) throw new Error('pickWeighted() called with an empty list');
  return last;
}
