import { addProtocol, setWorkerUrl } from 'maplibre-gl';
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { PMTiles, Protocol } from 'pmtiles';
import { type Flavor, layers as flavorLayers, namedFlavor } from '@protomaps/basemaps';
import type { Feature, FeatureCollection } from 'geojson';
import type { LocationStats } from '@tracearr/shared';
import { API_BASE_URL } from '@/lib/api';
import { type Area, circleRadius } from './areas';
import { locationKey } from './locationKey';

setWorkerUrl(workerUrl);

const BASEMAP_URL = `${API_BASE_URL}/map/basemap`;

const protocol = new Protocol();
addProtocol('pmtiles', protocol.tile);
// One shared archive: the availability probe and the tile protocol reuse the
// same header and directory cache instead of fetching them twice.
const basemapArchive = new PMTiles(BASEMAP_URL);
protocol.add(basemapArchive);

let basemapCheck: Promise<boolean> | null = null;
let archiveMaxZoom: number | null = null;

export function checkBasemap(): Promise<boolean> {
  basemapCheck ??= basemapArchive
    .getHeader()
    .then((header) => {
      archiveMaxZoom = header.maxZoom;
      return true;
    })
    .catch(() => false);
  return basemapCheck;
}

// Vector tiles overzoom cleanly for a level or two; past that the coastlines
// turn to polygons. The floor keeps the heat to circle crossfade reachable on
// a shallow archive.
const MAX_OVERZOOM = 2;

export function mapMaxZoom(archiveZoom = archiveMaxZoom): number {
  return archiveZoom === null ? 14 : Math.max(HEAT_FADE.end, archiveZoom + MAX_OVERZOOM);
}

// The world is 512 px wide at zoom 0, so below this zoom the map would show it more than once.
export function worldFillZoom(width: number): number {
  return width > 512 ? Math.log2(width / 512) : 0;
}

let webglSupport: boolean | null = null;

// maplibre v6 needs webgl2 and fires its GPU error inside the Map constructor,
// before a caller can attach a listener, so probe before constructing one.
export function isWebglSupported(): boolean {
  if (webglSupport === null) {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      webglSupport = gl !== null;
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}

export const DEFAULT_SERVER_COLOR = 'hsl(142, 76%, 48%)';

export function hsl(h: number, s: number, l: number, a?: number): string {
  return a === undefined ? `hsl(${h}, ${s}%, ${l}%)` : `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

/**
 * An OKLCH color as CSS `rgb()`/`rgba()`. The basemap paints on WebGL and cannot read the
 * gray tokens, so it builds the same accent-tinted grays from their lightness here.
 */
export function oklchRgb(l: number, c: number, h: number, alpha?: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const lms = [
    (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    (l - 0.0894841775 * a - 1.291485548 * b) ** 3,
  ] as const;
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2],
  ];
  const [r, g, bl] = linear.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255);
  });
  return alpha === undefined ? `rgb(${r}, ${g}, ${bl})` : `rgba(${r}, ${g}, ${bl}, ${alpha})`;
}

/** A basemap gray at lightness `l` on the accent hue, with the chroma the gray tokens use. */
function gray(l: number, dark: boolean, accentH: number, variant = false): string {
  if (l >= 0.995) return oklchRgb(1, 0, 0);
  const chroma = dark ? (variant ? 0.016 : 0.012) : variant ? 0.014 : 0.006;
  return oklchRgb(l, chroma, accentH);
}

export function colorToHue(color: string): number | null {
  const hslMatch = /^hsla?\(\s*(-?[\d.]+)/.exec(color);
  if (hslMatch?.[1] !== undefined) return ((Number(hslMatch[1]) % 360) + 360) % 360;
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!hexMatch?.[1]) return null;
  let hex = hexMatch[1];
  if (hex.length === 3) hex = hex.replace(/./g, '$&$&');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (((h * 60) % 360) + 360) % 360;
}

function heatColorRamp(hue: number): ExpressionSpecification {
  return [
    'interpolate',
    ['linear'],
    ['heatmap-density'],
    0,
    'rgba(0,0,0,0)',
    0.15,
    hsl(hue, 85, 31, 0.55),
    0.4,
    hsl(hue, 86, 42),
    0.6,
    hsl(hue, 80, 50),
    0.8,
    hsl(hue, 80, 60),
    0.95,
    hsl(hue, 80, 70),
    1,
    '#ffffff',
  ];
}

// Ground-anchored radius: kilometres converted to pixels per zoom, clamped to
// a band so the blob neither vanishes at world view nor swallows the screen.
const RADIUS_KM = 6;
const RADIUS_MIN_PX = 18;
const RADIUS_MAX_PX = 90;

function heatRadiusExpr(): ExpressionSpecification {
  const stops: number[] = [];
  for (let z = 0; z <= 14; z++) {
    const mpp = (156543.03392 * Math.cos((40 * Math.PI) / 180)) / 2 ** z;
    stops.push(z, Math.min(RADIUS_MAX_PX, Math.max(RADIUS_MIN_PX, (RADIUS_KM * 1000) / mpp)));
  }
  return ['interpolate', ['linear'], ['zoom'], ...stops] as ExpressionSpecification;
}

// Heatmap reads as density only above the data's city-level precision; past
// z8.5 it crossfades into per-location circles, with counts from z9.5.
export const HEAT_FADE = { start: 8.5, end: 10, circlesIn: 9.5 };

export function heatmapLayer(
  id: string,
  source: string,
  hue: number,
  filter?: ExpressionSpecification
): LayerSpecification {
  return {
    id,
    type: 'heatmap',
    source,
    ...(filter ? { filter } : {}),
    paint: {
      'heatmap-weight': ['get', 'w'],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 9, 3],
      'heatmap-radius': heatRadiusExpr(),
      'heatmap-color': heatColorRamp(hue),
      'heatmap-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        HEAT_FADE.start,
        1,
        HEAT_FADE.end,
        0,
      ],
    },
  };
}

export const HIGHLIGHTED: ExpressionSpecification = [
  'any',
  ['boolean', ['feature-state', 'hover'], false],
  ['boolean', ['feature-state', 'selected'], false],
];

/** Highlighting raises a circle's opacity to at least 0.75 and never lowers it. */
export function highlightOpacity(base: ExpressionSpecification | number): ExpressionSpecification {
  return ['case', HIGHLIGHTED, ['max', 0.75, base], base];
}

/** One circle per place or area: a translucent fill, so the map reads through, inside a solid ring. */
export function circlesLayer(
  source: string,
  color: ExpressionSpecification | string,
  strokeColor: ExpressionSpecification | string
): LayerSpecification {
  return {
    id: 'circles',
    type: 'circle',
    source,
    paint: {
      'circle-radius': ['get', 'r'],
      'circle-color': color,
      'circle-stroke-color': ['case', HIGHLIGHTED, '#ffffff', strokeColor],
      'circle-stroke-width': ['case', HIGHLIGHTED, 2, 1.5],
      'circle-opacity': highlightOpacity(['+', 0.3, ['*', 0.3, ['get', 'w']]]),
      'circle-stroke-opacity': 1,
    },
  };
}

export function crossfadeCircleLayers(
  source: string,
  color: ExpressionSpecification | string,
  strokeColor: ExpressionSpecification | string,
  dark: boolean,
  accentH: number
): LayerSpecification[] {
  return [
    {
      id: 'pts-auto',
      type: 'circle',
      source,
      minzoom: HEAT_FADE.start,
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': color,
        'circle-stroke-color': ['case', HIGHLIGHTED, '#ffffff', strokeColor],
        'circle-stroke-width': ['case', HIGHLIGHTED, 2, 1.5],
        'circle-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          HEAT_FADE.start,
          0,
          HEAT_FADE.circlesIn,
          highlightOpacity(0.55),
        ],
        'circle-stroke-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          HEAT_FADE.start,
          0,
          HEAT_FADE.circlesIn,
          0.95,
        ],
      },
    },
    {
      id: 'pts-count',
      type: 'symbol',
      source,
      minzoom: HEAT_FADE.circlesIn,
      layout: {
        'text-field': ['to-string', ['get', 'count']],
        'text-font': ['Noto Sans Medium'],
        'text-size': 10.5,
      },
      paint: {
        'text-color': gray(dark ? 0.903 : 0.292, dark, accentH, true),
        'text-halo-color': dark ? oklchRgb(0.164, 0.012, accentH, 0.85) : oklchRgb(1, 0, 0, 0.85),
        'text-halo-width': 1.2,
      },
    },
  ];
}

export interface LocationFeatureProps {
  key: string;
  w: number;
  r: number;
  count: number;
  serverId: string | null;
  members: number;
}

type PlacedLocation = LocationStats & { lat: number; lon: number };

export function hasMapPosition(l: LocationStats): l is PlacedLocation {
  return l.lat !== null && l.lon !== null;
}

/** Longitudes in [-180, 180]; west is past east when the view crosses the antimeridian. */
export interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function inView(l: PlacedLocation, b: ViewBounds): boolean {
  const lonIn =
    b.west <= b.east ? l.lon >= b.west && l.lon <= b.east : l.lon >= b.west || l.lon <= b.east;
  return lonIn && l.lat >= b.south && l.lat <= b.north;
}

interface Slice {
  serverId: string | null;
  count: number;
}

function slices(l: PlacedLocation, perServer: boolean): Slice[] {
  if (perServer && l.servers?.length) {
    return l.servers.map((s) => ({ serverId: s.serverId || null, count: s.count }));
  }
  return [{ serverId: null, count: l.count }];
}

const sliceServer = (l: PlacedLocation, serverId: string | null) =>
  serverId ?? l.servers?.[0]?.serverId ?? null;

interface Group {
  key: string;
  members: PlacedLocation[];
}

function placed(locations: LocationStats[], areas: Area[] | undefined) {
  const valid = locations.filter(hasMapPosition);
  const maxCount = Math.max(...valid.map((l) => l.count), 1);
  const max = Math.log10(maxCount + 1);
  const byKey = new Map(valid.map((l) => [locationKey(l), l]));
  const groups: Group[] = areas
    ? areas.map((a) => ({ key: a.key, members: a.members.flatMap((k) => byKey.get(k) ?? []) }))
    : valid.map((l) => ({ key: locationKey(l), members: [l] }));
  return { maxCount, weight: (count: number) => Math.log10(count + 1) / max, groups };
}

/** Each server's total across the group, and the first member that has that server. */
function groupSlices(members: PlacedLocation[], perServer: boolean) {
  const sums = new Map<string | null, { count: number; carrier: PlacedLocation }>();
  for (const m of members) {
    for (const s of slices(m, perServer)) {
      const sum = sums.get(s.serverId);
      if (sum) sum.count += s.count;
      else sums.set(s.serverId, { count: s.count, carrier: m });
    }
  }
  return sums;
}

/** Sizes a group the way multi-server mode draws it: by its largest per-server sum. */
export function largestServerCount(locations: LocationStats[]): (memberKeys: string[]) => number {
  const byKey = new Map(locations.filter(hasMapPosition).map((l) => [locationKey(l), l]));
  return (keys) => {
    const sums = groupSlices(
      keys.flatMap((k) => byKey.get(k) ?? []),
      true
    );
    return Math.max(0, ...[...sums.values()].map((s) => s.count));
  };
}

function pointFeature(lon: number, lat: number, properties: LocationFeatureProps): Feature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties };
}

/** Without areas, one feature per place; with them, one per area (per server in both cases). */
export function locationsGeojson(
  locations: LocationStats[],
  perServer: boolean,
  areas?: Area[]
): FeatureCollection {
  const { maxCount, weight, groups } = placed(locations, areas);
  const features = groups.flatMap(({ key, members }) => {
    const anchor = members[0];
    if (!anchor) return [];
    return [...groupSlices(members, perServer)].map(([serverId, { count }]) =>
      pointFeature(anchor.lon, anchor.lat, {
        key,
        w: weight(count),
        r: circleRadius(count, maxCount, members.length > 1),
        count,
        serverId: sliceServer(anchor, serverId),
        members: members.length,
      })
    );
  });
  return { type: 'FeatureCollection', features };
}

export interface PlaceCircle {
  key: string;
  serverId: string | null;
  count: number;
  lon: number;
  lat: number;
  r: number;
  w: number;
}

/**
 * Where each place's circle (per server) sits under a grouping. Inside an area the first member
 * with a server carries the area's circle and the rest shrink to nothing at its anchor, so a
 * transition starts and ends on exactly what the settled grouping draws.
 */
export function placeCircles(
  locations: LocationStats[],
  perServer: boolean,
  areas: Area[]
): Map<string, PlaceCircle> {
  const { maxCount, weight, groups } = placed(locations, areas);
  const circles = new Map<string, PlaceCircle>();
  for (const { members } of groups) {
    const anchor = members[0];
    if (!anchor) continue;
    const sums = groupSlices(members, perServer);
    for (const m of members) {
      const key = locationKey(m);
      for (const s of slices(m, perServer)) {
        const sum = sums.get(s.serverId);
        circles.set(JSON.stringify([key, s.serverId]), {
          key,
          serverId: sliceServer(m, s.serverId),
          count: s.count,
          lon: anchor.lon,
          lat: anchor.lat,
          r: sum?.carrier === m ? circleRadius(sum.count, maxCount, members.length > 1) : 0,
          w: weight(sum?.count ?? s.count),
        });
      }
    }
  }
  return circles;
}

export function lerpCircles(
  from: Map<string, PlaceCircle>,
  to: Map<string, PlaceCircle>,
  t: number
): Map<string, PlaceCircle> {
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return new Map(
    [...to].map(([id, c]) => {
      const f = from.get(id) ?? c;
      return [
        id,
        {
          ...c,
          lon: lerp(f.lon, c.lon),
          lat: lerp(f.lat, c.lat),
          r: lerp(f.r, c.r),
          w: lerp(f.w, c.w),
        },
      ];
    })
  );
}

export function circlesGeojson(circles: Map<string, PlaceCircle>): FeatureCollection {
  const features = [...circles.values()]
    .filter((c) => c.r > 0)
    .map(({ key, serverId, count, lon, lat, r, w }) =>
      pointFeature(lon, lat, { key, w, r, count, serverId, members: 1 })
    );
  return { type: 'FeatureCollection', features };
}

function fill(keys: readonly (keyof Flavor)[], color: string): Partial<Flavor> {
  return Object.fromEntries(keys.map((k) => [k, color]));
}

const PARK_KEYS = ['park_a', 'park_b', 'wood_a', 'wood_b', 'scrub_a', 'scrub_b'] as const;
const LANDUSE_KEYS = [
  'hospital',
  'industrial',
  'school',
  'zoo',
  'military',
  'pedestrian',
  'aerodrome',
  'sand',
  'beach',
  'pier',
  'runway',
] as const;
const MINOR_KEYS = [
  'other',
  'minor_service',
  'minor_a',
  'minor_b',
  'bridges_other',
  'bridges_minor',
] as const;
const MAJOR_KEYS = ['major', 'link', 'bridges_major', 'bridges_link'] as const;
const TUNNEL_KEYS = [
  'tunnel_other',
  'tunnel_minor',
  'tunnel_link',
  'tunnel_major',
  'tunnel_highway',
] as const;
const CASING_KEYS = [
  'minor_service_casing',
  'minor_casing',
  'link_casing',
  'major_casing_early',
  'major_casing_late',
  'highway_casing_early',
  'highway_casing_late',
  'tunnel_other_casing',
  'tunnel_minor_casing',
  'tunnel_link_casing',
  'tunnel_major_casing',
  'tunnel_highway_casing',
  'bridges_other_casing',
  'bridges_minor_casing',
  'bridges_link_casing',
  'bridges_major_casing',
  'bridges_highway_casing',
] as const;

// Water and vegetation keep fixed hues so they read as water and green on every preset; an
// orange or pink accent would turn accent-derived water beige or mauve.
const WATER_H = 235;
const GREEN_H = 150;

interface MapPalette {
  land: string;
  urban: string;
  forest: string;
  grass: string;
  landuse: string;
  water: string;
  buildings: string;
  minor: string;
  major: string;
  highway: string;
  tunnel: string;
  rail: string;
  boundary: string;
  country: string;
  state: string;
  city: string;
  town: string;
  subplace: string;
  road: string;
  waterLabel: string;
}

function palette(dark: boolean, accentH: number): MapPalette {
  const g = (l: number) => gray(l, dark, accentH);
  const label = (l: number) => gray(l, dark, accentH, true);
  const water = (l: number, c: number) => oklchRgb(l, c, WATER_H);
  const green = (l: number, c: number) => oklchRgb(l, c, GREEN_H);
  if (dark) {
    return {
      land: g(0.165),
      urban: g(0.19),
      forest: green(0.18, 0.012),
      grass: green(0.172, 0.008),
      landuse: g(0.18),
      water: water(0.125, 0.028),
      buildings: g(0.2),
      minor: g(0.225),
      major: g(0.27),
      highway: g(0.33),
      tunnel: g(0.205),
      rail: g(0.27),
      boundary: g(0.42),
      country: label(0.68),
      state: label(0.6),
      city: label(0.84),
      town: label(0.72),
      subplace: label(0.6),
      road: label(0.6),
      waterLabel: water(0.58, 0.04),
    };
  }
  return {
    land: g(0.975),
    urban: g(0.95),
    forest: green(0.95, 0.014),
    grass: green(0.962, 0.008),
    landuse: g(0.955),
    water: water(0.86, 0.035),
    buildings: g(0.93),
    minor: g(0.925),
    major: g(0.89),
    highway: g(0.84),
    tunnel: g(0.935),
    rail: g(0.86),
    boundary: g(0.74),
    country: label(0.5),
    state: label(0.58),
    city: label(0.36),
    town: label(0.46),
    subplace: label(0.55),
    road: label(0.55),
    waterLabel: water(0.5, 0.05),
  };
}

// Casings take the land color: at this archive's zooms a casing only thickens the line, and
// the road classes separate by their own lightness and width.
function flavorFor(p: MapPalette, dark: boolean): Flavor {
  return {
    ...namedFlavor(dark ? 'black' : 'white'),
    background: p.land,
    earth: p.land,
    landcover: {
      urban_area: p.urban,
      forest: p.forest,
      grassland: p.grass,
      farmland: p.grass,
      scrub: p.grass,
      barren: p.land,
      glacier: p.land,
    },
    ...fill(PARK_KEYS, p.forest),
    ...fill(LANDUSE_KEYS, p.landuse),
    glacier: p.land,
    water: p.water,
    buildings: p.buildings,
    ...fill(CASING_KEYS, p.land),
    ...fill(MINOR_KEYS, p.minor),
    ...fill(MAJOR_KEYS, p.major),
    ...fill(TUNNEL_KEYS, p.tunnel),
    highway: p.highway,
    bridges_highway: p.highway,
    railway: p.rail,
    boundaries: p.boundary,
    roads_label_minor: p.road,
    roads_label_major: p.road,
    ocean_label: p.waterLabel,
    subplace_label: p.subplace,
    city_label: p.city,
    state_label: p.state,
    country_label: p.country,
    address_label: p.road,
    ...fill(
      [
        'roads_label_minor_halo',
        'roads_label_major_halo',
        'subplace_label_halo',
        'city_label_halo',
        'state_label_halo',
        'address_label_halo',
      ],
      p.land
    ),
  };
}

/**
 * Data draws below the basemap's place names, so they stay readable over it, and above its road
 * and water labels; the data's own labels go on top of everything.
 */
export function addDataLayers(style: StyleSpecification, ...layers: LayerSpecification[]): void {
  const at = style.layers.findIndex((l) => l.id.startsWith('places_'));
  style.layers.splice(
    at === -1 ? style.layers.length : at,
    0,
    ...layers.filter((l) => l.type !== 'symbol')
  );
  style.layers.push(...layers.filter((l) => l.type === 'symbol'));
}

/**
 * Town names step down from city names in color. Place names sit beside their point at every zoom
 * (Protomaps centers them on it from z8, where the town dot goes), so a stream circle at a city's
 * coordinates is not buried under that city's name.
 */
function withPlaceLabels(layer: LayerSpecification, p: MapPalette): LayerSpecification {
  if (layer.id !== 'places_locality' || layer.type !== 'symbol') return layer;
  return {
    ...layer,
    layout: {
      ...layer.layout,
      'text-variable-anchor': ['bottom', 'left', 'right', 'top'],
      'text-radial-offset': ['step', ['zoom'], 0.3, 8, 0.8],
    },
    paint: {
      ...layer.paint,
      'text-color': ['case', ['<=', ['get', 'min_zoom'], 5], p.city, p.town],
      'text-halo-width': 1.5,
    },
  };
}

export interface BaseStyleOptions {
  dark: boolean;
  basemapOk: boolean;
  lang: string;
  /** The accent preset's OKLCH hue, which the basemap grays take. */
  accentH: number;
}

export function buildBaseStyle({
  dark,
  basemapOk,
  lang,
  accentH,
}: BaseStyleOptions): StyleSpecification {
  const assets = new URL('basemaps/', document.baseURI).href;
  const flavorName = dark ? 'dark' : 'light';
  const colors = palette(dark, accentH);
  const style: StyleSpecification = {
    version: 8,
    glyphs: `${assets}fonts/{fontstack}/{range}.pbf`,
    sprite: `${assets}sprites/${flavorName}`,
    sources: {},
    layers: [
      {
        id: 'app-background',
        type: 'background',
        paint: { 'background-color': colors.land },
      },
    ],
  };
  if (basemapOk) {
    style.sources.basemap = {
      type: 'vector',
      url: `pmtiles://${BASEMAP_URL}`,
      attribution:
        'Protomaps &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    };
    style.layers.push(
      ...flavorLayers('basemap', flavorFor(colors, dark), { lang })
        .filter((l) => l.type !== 'background')
        .map((l) => withPlaceLabels(l, colors))
    );
  }
  return style;
}
