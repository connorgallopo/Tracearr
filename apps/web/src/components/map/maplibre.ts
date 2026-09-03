import { addProtocol, setWorkerUrl } from 'maplibre-gl';
import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  LayerSpecification,
  StyleSpecification,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { PMTiles, Protocol } from 'pmtiles';
import { layers as flavorLayers, namedFlavor } from '@protomaps/basemaps';
import type { Feature, FeatureCollection } from 'geojson';
import type { LocationStats } from '@tracearr/shared';
import { API_BASE_URL } from '@/lib/api';

setWorkerUrl(workerUrl);

const BASEMAP_URL = `${API_BASE_URL}/map/basemap`;

const protocol = new Protocol();
addProtocol('pmtiles', protocol.tile);
// One shared archive: the availability probe and the tile protocol reuse the
// same header and directory cache instead of fetching them twice.
const basemapArchive = new PMTiles(BASEMAP_URL);
protocol.add(basemapArchive);

let basemapCheck: Promise<boolean> | null = null;

export function checkBasemap(): Promise<boolean> {
  basemapCheck ??= basemapArchive
    .getHeader()
    .then(() => true)
    .catch(() => false);
  return basemapCheck;
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

export function crossfadeCircleLayers(
  source: string,
  color: DataDrivenPropertyValueSpecification<string>,
  strokeColor: DataDrivenPropertyValueSpecification<string>,
  dark: boolean
): LayerSpecification[] {
  return [
    {
      id: 'pts-auto',
      type: 'circle',
      source,
      minzoom: HEAT_FADE.start,
      paint: {
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          9,
          ['+', 3, ['*', 9, ['sqrt', ['get', 'w']]]],
          13,
          ['+', 5, ['*', 18, ['sqrt', ['get', 'w']]]],
        ],
        'circle-color': color,
        'circle-stroke-color': strokeColor,
        'circle-stroke-width': 1.5,
        'circle-opacity': [
          'interpolate',
          ['linear'],
          ['zoom'],
          HEAT_FADE.start,
          0,
          HEAT_FADE.circlesIn,
          0.55,
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
        'text-color': dark ? 'hsl(220, 15%, 88%)' : 'hsl(215, 20%, 18%)',
        'text-halo-color': dark ? 'hsla(240, 10%, 6%, 0.85)' : 'hsla(0, 0%, 100%, 0.85)',
        'text-halo-width': 1.2,
      },
    },
  ];
}

export interface LocationFeatureProps {
  w: number;
  count: number;
  city: string | null;
  country: string | null;
  serverId: string | null;
  servers: { serverId: string; count: number }[] | null;
}

export function locationsGeojson(
  locations: LocationStats[],
  perServer: boolean
): FeatureCollection {
  const valid = locations.filter((l) => l.lat && l.lon);
  const max = Math.log10(Math.max(...valid.map((l) => l.count), 1) + 1);
  const feature = (l: LocationStats, count: number, serverId: string | null): Feature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
    properties: {
      w: Math.log10(count + 1) / max,
      count,
      city: l.city,
      country: l.country,
      serverId: serverId ?? l.servers?.[0]?.serverId ?? null,
      servers: l.servers ?? null,
    } satisfies LocationFeatureProps,
  });
  const features = perServer
    ? valid.flatMap((l) =>
        (l.servers?.length ? l.servers : [{ serverId: '', count: l.count }]).map((s) =>
          feature(l, s.count, s.serverId || null)
        )
      )
    : valid.map((l) => feature(l, l.count, null));
  return { type: 'FeatureCollection', features };
}

export interface BaseStyleOptions {
  dark: boolean;
  basemapOk: boolean;
  lang: string;
}

export function buildBaseStyle({ dark, basemapOk, lang }: BaseStyleOptions): StyleSpecification {
  const assets = new URL('basemaps/', document.baseURI).href;
  const flavorName = dark ? 'dark' : 'light';
  const style: StyleSpecification = {
    version: 8,
    glyphs: `${assets}fonts/{fontstack}/{range}.pbf`,
    sprite: `${assets}sprites/${flavorName}`,
    sources: {},
    layers: [
      {
        id: 'app-background',
        type: 'background',
        paint: { 'background-color': dark ? 'hsl(240, 10%, 4%)' : 'hsl(240, 5%, 96%)' },
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
      ...flavorLayers('basemap', namedFlavor(flavorName), { lang }).filter(
        (l) => l.type !== 'background'
      )
    );
  }
  return style;
}
