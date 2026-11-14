import { describe, expect, it, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn(), setWorkerUrl: vi.fn() }));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'worker.js' }));
vi.mock('pmtiles', () => ({
  PMTiles: class {
    getHeader() {
      return Promise.resolve({ maxZoom: 8 });
    }
  },
  Protocol: class {
    tile = vi.fn();
    add = vi.fn();
  },
}));
vi.mock('@protomaps/basemaps', () => ({ layers: () => [], namedFlavor: () => ({}) }));

import type { Point } from 'geojson';
import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';
import type { LocationStats } from '@tracearr/shared';
import { type Area, circleRadius } from './areas';
import {
  addDataLayers,
  checkBasemap,
  HEAT_FADE,
  hasMapPosition,
  locationsGeojson,
  mapMaxZoom,
  oklchRgb,
  worldFillZoom,
} from './maplibre';
import { locationKey } from './locationKey';

function location(overrides: Partial<LocationStats>): LocationStats {
  return {
    city: 'Trenton',
    region: 'New Jersey',
    country: 'US',
    isLocal: false,
    lat: 40.2,
    lon: -74.7,
    count: 1,
    users: [],
    peopleCount: 0,
    servers: [],
    ...overrides,
  };
}

describe('hasMapPosition', () => {
  it('keeps a coordinate of 0 on the equator or the Greenwich meridian', () => {
    expect(hasMapPosition(location({ lat: 0, lon: 0 }))).toBe(true);
    expect(hasMapPosition(location({ lat: null, lon: null }))).toBe(false);
  });
});

describe('locationsGeojson', () => {
  it('keys every feature by its location, one per server in multi-server mode', () => {
    const trenton = location({
      count: 3,
      servers: [
        { serverId: 'a', count: 2 },
        { serverId: 'b', count: 1 },
      ],
    });
    const paris = location({ city: 'Paris', region: null, country: 'FR', count: 1 });
    const { features } = locationsGeojson([trenton, paris], true);
    expect(features.map((f) => f.properties?.key)).toEqual([
      locationKey(trenton),
      locationKey(trenton),
      locationKey(paris),
    ]);
  });

  it('draws nothing for a location with no coordinates', () => {
    const { features } = locationsGeojson(
      [location({ city: 'Nowhere', lat: null, lon: null, count: 9 }), location({ lat: 0, lon: 0 })],
      false
    );
    expect(features.map((f) => (f.geometry as Point).coordinates)).toEqual([[0, 0]]);
  });

  it('sizes circles by area against the top location with a 5 px floor', () => {
    const { features } = locationsGeojson(
      [
        location({ count: 412 }),
        location({ city: 'Camden', count: 103 }),
        location({ city: 'Ewing', count: 1 }),
      ],
      false
    );
    expect(features.map((f) => f.properties?.r)).toEqual([28, 14, 5]);
  });

  it('sizes a per-server feature by its own count against the largest location total', () => {
    const { features } = locationsGeojson(
      [
        location({
          count: 400,
          servers: [
            { serverId: 'a', count: 100 },
            { serverId: 'b', count: 300 },
          ],
        }),
      ],
      true
    );
    expect(features.map((f) => f.properties?.r)).toEqual([14, 28 * Math.sqrt(0.75)]);
  });

  it('draws an area as one circle at its anchor sized from the summed count', () => {
    const trenton = location({ count: 40 });
    const ewing = location({ city: 'Ewing', lat: 40.27, lon: -74.8, count: 20 });
    const area: Area = {
      key: `area:${locationKey(trenton)}`,
      members: [locationKey(trenton), locationKey(ewing)],
      lon: -74.7,
      lat: 40.2,
      count: 60,
    };
    const { features } = locationsGeojson([trenton, ewing], false, [area]);
    expect(features).toHaveLength(1);
    expect((features[0]!.geometry as Point).coordinates).toEqual([-74.7, 40.2]);
    expect(features[0]?.properties).toMatchObject({
      key: area.key,
      members: 2,
      count: 60,
      r: circleRadius(60, 40, true),
    });
  });

  it('draws an area once per server with that server summed across members', () => {
    const trenton = location({
      count: 40,
      servers: [
        { serverId: 'a', count: 30 },
        { serverId: 'b', count: 10 },
      ],
    });
    const ewing = location({
      city: 'Ewing',
      count: 20,
      servers: [{ serverId: 'b', count: 20 }],
    });
    const key = `area:${locationKey(trenton)}`;
    const area: Area = {
      key,
      members: [locationKey(trenton), locationKey(ewing)],
      lon: -74.7,
      lat: 40.2,
      count: 60,
    };
    const { features } = locationsGeojson([trenton, ewing], true, [area]);
    expect(features.map((f) => f.properties)).toEqual([
      expect.objectContaining({
        key,
        serverId: 'a',
        count: 30,
        members: 2,
        r: circleRadius(30, 40, true),
      }),
      expect.objectContaining({
        key,
        serverId: 'b',
        count: 30,
        members: 2,
        r: circleRadius(30, 40, true),
      }),
    ]);
  });

  it('keeps one feature per place when no areas are given', () => {
    const trenton = location({ count: 412 });
    const ewing = location({ city: 'Ewing', count: 1, servers: [{ serverId: 'a', count: 1 }] });
    const { features } = locationsGeojson([trenton, ewing], false);
    expect(features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-74.7, 40.2] },
        properties: {
          key: locationKey(trenton),
          w: 1,
          r: 28,
          count: 412,
          serverId: null,
          members: 1,
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-74.7, 40.2] },
        properties: {
          key: locationKey(ewing),
          w: Math.log10(2) / Math.log10(413),
          r: 5,
          count: 1,
          serverId: 'a',
          members: 1,
        },
      },
    ]);
  });
});

describe('mapMaxZoom', () => {
  it('allows two levels past the archive once the header is known', async () => {
    await checkBasemap();
    expect(mapMaxZoom()).toBe(10);
  });

  it('never drops below the heat to circle crossfade', () => {
    expect(mapMaxZoom(6)).toBe(HEAT_FADE.end);
  });
});

describe('worldFillZoom', () => {
  it('is the zoom at which one copy of the world spans the width', () => {
    expect(worldFillZoom(512)).toBe(0);
    expect(worldFillZoom(2048)).toBe(2);
  });

  it('lets a map narrowed by the location column fit a US to Thailand spread', () => {
    // 1296 px of map beside the 380 px column needs zoom 1.92 to show 222 degrees with padding.
    expect(worldFillZoom(1296)).toBeLessThan(1.92);
  });

  it('never goes below zero for a narrow or unmeasured container', () => {
    expect(worldFillZoom(0)).toBe(0);
    expect(worldFillZoom(300)).toBe(0);
  });
});

describe('oklchRgb', () => {
  it('converts OKLCH to the sRGB the gray tokens render as', () => {
    expect(oklchRgb(1, 0, 0)).toBe('rgb(255, 255, 255)');
    expect(oklchRgb(0.142, 0.012, 212)).toBe('rgb(5, 11, 12)');
    expect(oklchRgb(0.884, 0.006, 293, 0.85)).toBe('rgba(217, 216, 220, 0.85)');
  });
});

describe('addDataLayers', () => {
  it('draws data below the place names and its own labels above them', () => {
    const layer = (id: string, type: 'circle' | 'line' | 'symbol'): LayerSpecification =>
      ({ id, type, source: 'basemap' }) as LayerSpecification;
    const style: StyleSpecification = {
      version: 8,
      sources: {},
      layers: [
        layer('roads', 'line'),
        layer('roads_shields', 'symbol'),
        layer('places_locality', 'symbol'),
      ],
    };
    addDataLayers(style, layer('circles', 'circle'), layer('pts-count', 'symbol'));
    expect(style.layers.map((l) => l.id)).toEqual([
      'roads',
      'roads_shields',
      'circles',
      'places_locality',
      'pts-count',
    ]);
  });
});
