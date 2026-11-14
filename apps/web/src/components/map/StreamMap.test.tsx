import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { FeatureCollection } from 'geojson';
import type { StyleSpecification } from 'maplibre-gl';
import type { LocationStats } from '@tracearr/shared';
import { groupIntoAreas, mercatorAt } from './areas';
import { locationKey } from './locationKey';
import { HEAT_FADE, HIGHLIGHTED, locationsGeojson } from './maplibre';
import { StreamMap } from './StreamMap';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
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
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ accentHue: 200 }) }));
vi.mock('./areas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./areas')>();
  return { ...actual, groupIntoAreas: vi.fn(actual.groupIntoAreas) };
});
vi.mock('./maplibre', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./maplibre')>()),
  isWebglSupported: () => true,
}));

type Handler = (e: Record<string, unknown>) => void;

const fake = vi.hoisted(() => {
  const handlers: Record<string, Handler[]> = {};
  const name = (event: string, layer: string | Handler) =>
    typeof layer === 'string' ? `${event}:${layer}` : event;
  const fake = {
    handlers,
    style: null as StyleSpecification | null,
    zoom: 3,
    center: { lng: 1, lat: 2 },
    bounds: { west: -80, south: 35, east: -70, north: 45 },
    source: { setData: vi.fn() },
    map: {
      on: (event: string, layer: string | Handler, fn?: Handler) => {
        (handlers[name(event, layer)] ??= []).push(typeof layer === 'string' ? fn! : layer);
      },
      off: (event: string, layer: string | Handler, fn?: Handler) => {
        const list = handlers[name(event, layer)] ?? [];
        const target = typeof layer === 'string' ? fn : layer;
        handlers[name(event, layer)] = list.filter((h) => h !== target);
      },
      getCanvas: () => ({ style: {} }),
      getSource: () => fake.source,
      setFeatureState: vi.fn(),
      removeFeatureState: vi.fn(),
      easeTo: vi.fn(),
      fitBounds: vi.fn(),
      getCenter: () => fake.center,
      getZoom: () => fake.zoom,
      getBounds: () => ({
        getWest: () => fake.bounds.west,
        getSouth: () => fake.bounds.south,
        getEast: () => fake.bounds.east,
        getNorth: () => fake.bounds.north,
      }),
    },
  };
  return fake;
});

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
let reducedMotion = false;

function flushFrames(now = 0) {
  const due = [...frames.values()];
  frames.clear();
  act(() => due.forEach((cb) => cb(now)));
}

function fire(event: string, payload: Record<string, unknown> = {}) {
  act(() => fake.handlers[event]?.forEach((fn) => fn(payload)));
}

function zoomTo(zoom: number) {
  fake.zoom = zoom;
  fire('zoom');
}

vi.mock('./useMapLibre', async (importOriginal) => {
  const { fitTo, useAutoFit } = await importOriginal<typeof import('./useMapLibre')>();
  return {
    fitTo,
    useAutoFit,
    useMapLibre: (_ref: unknown, style: StyleSpecification | null) => {
      fake.style = style;
      return fake.map;
    },
    useBasemapAvailable: () => true,
    useResolvedDark: () => false,
    useAccentH: () => 212,
    useMapLang: () => 'en',
  };
});

function location(overrides: Partial<LocationStats>): LocationStats {
  return {
    city: 'Trenton',
    region: 'New Jersey',
    country: 'US',
    isLocal: false,
    lat: 40.2,
    lon: -74.7,
    count: 4,
    users: [],
    peopleCount: 2,
    servers: [],
    ...overrides,
  };
}

const trenton = location({});
const unplaced = location({ city: 'Ewing', lat: null, lon: null });
const ewing = location({ city: 'Ewing', lat: 40.27, lon: -74.8, count: 2 });
const pair = [trenton, ewing];
const areaKey = `area:${locationKey(trenton)}`;
const pairPoints = pair.map((l) => ({
  key: locationKey(l),
  lon: l.lon!,
  lat: l.lat!,
  count: l.count,
}));
const pairAt = (zoom: number) =>
  locationsGeojson(pair, false, groupIntoAreas(pairPoints, mercatorAt(zoom), 4));
const keys = (...ls: LocationStats[]) => new Set(ls.map(locationKey));

describe('StreamMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(fake.handlers)) delete fake.handlers[key];
    fake.zoom = 3;
    fake.center = { lng: 1, lat: 2 };
    fake.bounds = { west: -80, south: 35, east: -70, north: 45 };
    frames.clear();
    reducedMotion = false;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.set(nextFrame, cb);
      return nextFrame++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: reducedMotion && query === '(prefers-reduced-motion: reduce)',
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('eases to a selected location at city zoom and back to the earlier camera when cleared', () => {
    const { rerender } = render(<StreamMap locations={[trenton]} selectedMembers={new Set()} />);
    rerender(<StreamMap locations={[trenton]} selectedMembers={keys(trenton)} />);
    expect(fake.map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ center: [-74.7, 40.2], zoom: 9 })
    );
    rerender(<StreamMap locations={[trenton]} selectedMembers={new Set()} />);
    expect(fake.map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ center: { lng: 1, lat: 2 }, zoom: 3 })
    );
  });

  it('eases to the end of the heatmap fade in heatmap view so the circle is fully drawn', () => {
    const { rerender } = render(
      <StreamMap locations={[trenton]} viewMode="heatmap" selectedMembers={new Set()} />
    );
    rerender(
      <StreamMap locations={[trenton]} viewMode="heatmap" selectedMembers={keys(trenton)} />
    );
    expect(fake.map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ zoom: HEAT_FADE.end })
    );
  });

  it('fits the new points instead of the earlier camera when the locations changed meanwhile', () => {
    const boise = location({ city: 'Boise', lat: 43.6, lon: -116.2 });
    const { rerender } = render(<StreamMap locations={[trenton]} selectedMembers={new Set()} />);
    rerender(<StreamMap locations={[trenton]} selectedMembers={keys(trenton)} />);
    fake.map.fitBounds.mockClear();
    rerender(<StreamMap locations={[trenton, boise]} selectedMembers={keys(trenton)} />);
    expect(fake.map.fitBounds).not.toHaveBeenCalled();
    fake.map.easeTo.mockClear();

    rerender(<StreamMap locations={[trenton, boise]} selectedMembers={new Set()} />);

    expect(fake.map.fitBounds).toHaveBeenCalledTimes(1);
    expect(fake.map.easeTo).not.toHaveBeenCalled();
  });

  it('never lowers the opacity of a highlighted circle below its own', () => {
    render(<StreamMap locations={[trenton]} />);
    const circles = fake.style?.layers.find((l) => l.id === 'circles');
    const opacity = circles && 'paint' in circles ? circles.paint : undefined;
    const base = ['+', 0.3, ['*', 0.3, ['get', 'w']]];
    expect(opacity).toMatchObject({
      'circle-opacity': ['case', HIGHLIGHTED, ['max', 0.75, base], base],
    });
  });

  it('never moves the camera for a location without coordinates', () => {
    const { rerender } = render(<StreamMap locations={[unplaced]} selectedMembers={new Set()} />);
    rerender(<StreamMap locations={[unplaced]} selectedMembers={keys(unplaced)} />);
    rerender(<StreamMap locations={[unplaced]} selectedMembers={new Set()} />);
    expect(fake.map.easeTo).not.toHaveBeenCalled();
  });

  it('marks hover and selection on every feature sharing the location key', () => {
    render(
      <StreamMap
        locations={[trenton]}
        hoveredKeys={keys(trenton)}
        selectedMembers={keys(trenton)}
      />
    );
    expect(fake.style?.sources.streams).toMatchObject({ promoteId: 'key' });
    expect(fake.map.setFeatureState).toHaveBeenCalledWith(
      { source: 'streams', id: locationKey(trenton) },
      { hover: true }
    );
    expect(fake.map.setFeatureState).toHaveBeenCalledWith(
      { source: 'streams', id: locationKey(trenton) },
      { selected: true }
    );
  });

  it('reports hover and click on a circle and shows its tooltip', () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    render(<StreamMap locations={[trenton]} onHover={onHover} onSelect={onSelect} />);
    const event = {
      features: [{ properties: { key: locationKey(trenton) } }],
      point: { x: 5, y: 6 },
    };

    act(() => fake.handlers['mousemove:circles']?.forEach((fn) => fn(event)));
    expect(onHover).toHaveBeenLastCalledWith([locationKey(trenton)]);
    expect(screen.getByText('Trenton')).toBeInTheDocument();
    expect(screen.getByText(/map\.peopleCount/)).toBeInTheDocument();

    act(() => fake.handlers['click:circles']?.forEach((fn) => fn(event)));
    expect(onSelect).toHaveBeenCalledWith(locationKey(trenton));

    act(() => fake.handlers['mouseleave:circles']?.forEach((fn) => fn({})));
    expect(onHover).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText('Trenton')).not.toBeInTheDocument();
  });

  it('groups the circles at the map zoom and regroups on zoom, never on pan', () => {
    reducedMotion = true;
    render(<StreamMap locations={pair} />);
    expect(fake.style?.sources.streams).toMatchObject({ data: pairAt(3) });
    expect(pairAt(3).features.map((f) => f.properties?.key)).toEqual([areaKey]);

    fake.zoom = 12;
    fire('move');
    flushFrames();
    expect(fake.source.setData).not.toHaveBeenCalled();

    fire('zoom');
    fire('zoom');
    expect(frames.size).toBe(1);
    flushFrames();
    expect(fake.source.setData).toHaveBeenCalledTimes(1);
    expect(fake.source.setData).toHaveBeenCalledWith(pairAt(12));
    expect(pairAt(12).features).toHaveLength(2);
    expect(frames.size).toBe(0);
  });

  it('groups once per quarter zoom step while zooming and at the exact zoom once it stops', () => {
    fake.zoom = 2;
    render(<StreamMap locations={pair} />);
    const grouped = vi.mocked(groupIntoAreas);
    expect(grouped).toHaveBeenCalledTimes(1);

    zoomTo(2.05);
    flushFrames();
    expect(grouped).toHaveBeenCalledTimes(1);
    zoomTo(2.2);
    flushFrames();
    expect(grouped).toHaveBeenCalledTimes(2);
    zoomTo(2.3);
    flushFrames();
    expect(grouped).toHaveBeenCalledTimes(2);

    zoomTo(2.31);
    fire('moveend');
    expect(frames.size).toBe(0);
    expect(grouped).toHaveBeenCalledTimes(3);
    fire('moveend');
    expect(grouped).toHaveBeenCalledTimes(3);
  });

  it('groups by the per-server circles it draws in multi-server mode', () => {
    fake.zoom = 2;
    const servers = [
      { serverId: 'a', count: 50 },
      { serverId: 'b', count: 50 },
    ];
    const west = location({ city: 'West', lat: 0, lon: 0, count: 100, servers });
    const east = location({ city: 'East', lat: 0, lon: 7.9, count: 100, servers });
    const points = [west, east].map((l) => ({
      key: locationKey(l),
      lon: l.lon!,
      lat: l.lat!,
      count: l.count,
    }));
    expect(groupIntoAreas(points, mercatorAt(2), 100)).toHaveLength(1);

    render(
      <StreamMap
        locations={[west, east]}
        isMultiServer
        serverColorMap={
          new Map([
            ['a', '#ff0000'],
            ['b', '#0000ff'],
          ])
        }
      />
    );
    const { data } = fake.style!.sources.streams as { data: FeatureCollection };
    expect(new Set(data.features.map((f) => f.properties?.key))).toEqual(
      new Set(points.map((p) => p.key))
    );
    expect(data.features).toHaveLength(4);
  });

  it('draws places ungrouped in heatmap view', () => {
    render(<StreamMap locations={pair} viewMode="heatmap" />);
    expect(fake.style?.sources.streams).toMatchObject({ data: locationsGeojson(pair, false) });
    zoomTo(12);
    flushFrames();
    expect(fake.source.setData).not.toHaveBeenCalled();
  });

  it('animates a split over several frames and settles on the new grouping', () => {
    render(<StreamMap locations={pair} />);
    zoomTo(12);
    flushFrames();
    expect(frames.size).toBe(1);

    flushFrames(1000);
    flushFrames(1100);
    const midway = fake.source.setData.mock.lastCall?.[0] as FeatureCollection;
    expect(midway.features.map((f) => f.properties?.key)).toEqual(pair.map(locationKey));
    expect(frames.size).toBe(1);

    flushFrames(1300);
    expect(fake.source.setData).toHaveBeenLastCalledWith(pairAt(12));
    expect(frames.size).toBe(0);
  });

  it('replaces a running animation with the next grouping change', () => {
    render(<StreamMap locations={pair} />);
    zoomTo(12);
    flushFrames();
    flushFrames(1000);

    zoomTo(3);
    flushFrames(1100);
    flushFrames(1200);
    flushFrames(1500);

    expect(fake.source.setData).toHaveBeenLastCalledWith(pairAt(3));
    expect(fake.source.setData).not.toHaveBeenCalledWith(pairAt(12));
    expect(frames.size).toBe(0);
  });

  it('reports every member when an area is hovered and fits the camera to them on click', () => {
    const onHover = vi.fn();
    const onSelect = vi.fn();
    const onSelectArea = vi.fn();
    render(
      <StreamMap
        locations={pair}
        onHover={onHover}
        onSelect={onSelect}
        onSelectArea={onSelectArea}
      />
    );
    const event = { features: [{ properties: { key: areaKey } }], point: { x: 5, y: 6 } };

    act(() => fake.handlers['mousemove:circles']?.forEach((fn) => fn(event)));
    expect(onHover).toHaveBeenLastCalledWith(pair.map(locationKey));
    expect(screen.getByText('map.areaName')).toBeInTheDocument();
    expect(screen.getByText('map.streamsAcrossPlaces')).toBeInTheDocument();

    act(() => fake.handlers['click:circles']?.forEach((fn) => fn(event)));
    expect(onSelectArea).toHaveBeenCalledWith(pair.map(locationKey));
    expect(onSelect).not.toHaveBeenCalled();
    expect(fake.map.fitBounds).toHaveBeenLastCalledWith(
      [
        [-74.8, 40.2],
        [-74.7, 40.27],
      ],
      expect.objectContaining({ padding: 120, maxZoom: 12 })
    );
  });

  it('highlights every drawn circle that holds a hovered or selected place', () => {
    reducedMotion = true;
    render(
      <StreamMap locations={pair} hoveredKeys={keys(ewing)} selectedMembers={keys(trenton)} />
    );
    expect(fake.map.setFeatureState).toHaveBeenCalledWith(
      { source: 'streams', id: areaKey },
      { hover: true }
    );
    expect(fake.map.setFeatureState).toHaveBeenCalledWith(
      { source: 'streams', id: areaKey },
      { selected: true }
    );

    fake.map.setFeatureState.mockClear();
    zoomTo(12);
    flushFrames();
    expect(fake.map.setFeatureState).toHaveBeenCalledWith(
      { source: 'streams', id: locationKey(ewing) },
      { hover: true }
    );
    expect(fake.map.setFeatureState).toHaveBeenCalledWith(
      { source: 'streams', id: locationKey(trenton) },
      { selected: true }
    );
    expect(fake.map.setFeatureState).not.toHaveBeenCalledWith(
      { source: 'streams', id: areaKey },
      expect.anything()
    );
  });

  it('keeps the highlight on the circle carrying a hovered or selected place while it merges', () => {
    reducedMotion = true;
    render(<StreamMap locations={pair} hoveredKeys={keys(ewing)} selectedMembers={keys(ewing)} />);
    zoomTo(12);
    flushFrames();
    reducedMotion = false;
    zoomTo(3);
    flushFrames();
    fake.map.setFeatureState.mockClear();
    flushFrames(1000);

    expect(fake.map.setFeatureState).toHaveBeenCalledWith(
      { source: 'streams', id: locationKey(trenton) },
      { hover: true }
    );
    expect(fake.map.setFeatureState).toHaveBeenCalledWith(
      { source: 'streams', id: locationKey(trenton) },
      { selected: true }
    );
  });

  it('eases a place picked from the list to city zoom even when the map is closer in', () => {
    fake.zoom = 11;
    const { rerender } = render(<StreamMap locations={pair} selectedMembers={new Set()} />);
    rerender(<StreamMap locations={pair} selectedMembers={keys(ewing)} />);
    expect(fake.map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ center: [-74.8, 40.27], zoom: 9 })
    );
  });

  it('reports the view bounds on load and when a move ends, not while moving', () => {
    const onViewChange = vi.fn();
    render(<StreamMap locations={pair} onViewChange={onViewChange} />);
    expect(onViewChange).not.toHaveBeenCalled();

    fire('load');
    expect(onViewChange).toHaveBeenLastCalledWith({ west: -80, south: 35, east: -70, north: 45 });

    fake.bounds = { west: -90, south: 30, east: -60, north: 50 };
    fire('move');
    expect(onViewChange).toHaveBeenCalledTimes(1);
    fire('moveend');
    expect(onViewChange).toHaveBeenCalledTimes(2);
    expect(onViewChange).toHaveBeenLastCalledWith({ west: -90, south: 30, east: -60, north: 50 });
  });

  it('wraps view bounds that cross the antimeridian and spans the world when zoomed far out', () => {
    const onViewChange = vi.fn();
    render(<StreamMap locations={pair} onViewChange={onViewChange} />);
    fake.bounds = { west: 170, south: -30, east: 195, north: 0 };
    fire('moveend');
    expect(onViewChange).toHaveBeenLastCalledWith({ west: 170, south: -30, east: -165, north: 0 });

    fake.bounds = { west: -300, south: -80, east: 300, north: 80 };
    fire('moveend');
    expect(onViewChange).toHaveBeenLastCalledWith({ west: -180, south: -80, east: 180, north: 80 });
  });

  it('fits every point again each time the fit-all signal changes', () => {
    const { rerender } = render(<StreamMap locations={pair} fitAllSignal={0} />);
    fake.map.fitBounds.mockClear();
    rerender(<StreamMap locations={pair} fitAllSignal={1} />);
    expect(fake.map.fitBounds).toHaveBeenCalledTimes(1);
    expect(fake.map.fitBounds).toHaveBeenLastCalledWith(
      [
        [-74.8, 40.2],
        [-74.7, 40.27],
      ],
      expect.objectContaining({ maxZoom: 8 })
    );
    rerender(<StreamMap locations={[...pair]} fitAllSignal={1} />);
    expect(fake.map.fitBounds).toHaveBeenCalledTimes(1);
  });

  describe('camera around an area selection', () => {
    const event = { features: [{ properties: { key: areaKey } }], point: { x: 5, y: 6 } };

    function selectArea(rerender: ReturnType<typeof render>['rerender']) {
      act(() => fake.handlers['click:circles']?.forEach((fn) => fn(event)));
      rerender(<StreamMap locations={pair} selectedMembers={keys(trenton, ewing)} />);
      fake.center = { lng: -74.75, lat: 40.23 };
      fake.zoom = 11;
    }

    it('restores the camera from before the area click when the selection clears', () => {
      const { rerender } = render(<StreamMap locations={pair} selectedMembers={new Set()} />);
      selectArea(rerender);
      rerender(<StreamMap locations={pair} selectedMembers={new Set()} />);
      expect(fake.map.easeTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ center: { lng: 1, lat: 2 }, zoom: 3 })
      );
    });

    it('keeps the camera from before the area click when going on to one of its places', () => {
      const { rerender } = render(<StreamMap locations={pair} selectedMembers={new Set()} />);
      selectArea(rerender);
      rerender(<StreamMap locations={pair} selectedMembers={keys(ewing)} />);
      expect(fake.map.easeTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ center: [-74.8, 40.27], zoom: 11 })
      );
      rerender(<StreamMap locations={pair} selectedMembers={new Set()} />);
      expect(fake.map.easeTo).toHaveBeenLastCalledWith(
        expect.objectContaining({ center: { lng: 1, lat: 2 }, zoom: 3 })
      );
    });
  });
});
