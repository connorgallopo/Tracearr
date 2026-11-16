import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ExpressionSpecification,
  GeoJSONSource,
  LngLat,
  Map as MLMap,
  MapLayerMouseEvent,
  StyleSpecification,
} from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { useTranslation } from 'react-i18next';
import type { LocationStats } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/theme-provider';
import { type Area, type AreaPoint, groupIntoAreas, mercatorAt } from './areas';
import { autoFitBounds, type FitPoint } from './autoFitBounds';
import { locationKey, locationName } from './locationKey';
import { MapUnavailable } from './MapUnavailable';
import {
  addDataLayers,
  buildBaseStyle,
  circlesGeojson,
  circlesLayer,
  colorToHue,
  crossfadeCircleLayers,
  DEFAULT_SERVER_COLOR,
  hasMapPosition,
  HEAT_FADE,
  heatmapLayer,
  hsl,
  isWebglSupported,
  largestServerCount,
  lerpCircles,
  locationsGeojson,
  type PlaceCircle,
  placeCircles,
  type ViewBounds,
} from './maplibre';
import {
  useAccentH,
  fitTo,
  useAutoFit,
  useBasemapAvailable,
  useMapLang,
  useMapLibre,
  useResolvedDark,
} from './useMapLibre';

export type MapViewMode = 'heatmap' | 'circles';

interface StreamMapProps {
  locations: LocationStats[];
  className?: string;
  isLoading?: boolean;
  viewMode?: MapViewMode;
  filterKey?: string;
  serverColorMap?: Map<string, string | null>;
  isMultiServer?: boolean;
  hoveredKeys?: ReadonlySet<string>;
  selectedMembers?: ReadonlySet<string>;
  onHover?: (placeKeys: string[] | null) => void;
  onSelect?: (placeKey: string) => void;
  onSelectArea?: (members: string[]) => void;
  onViewChange?: (bounds: ViewBounds) => void;
  /** Each change fits the map to every point. */
  fitAllSignal?: number;
}

interface TooltipState {
  members: string[];
  x: number;
  y: number;
}

type Shown = Pick<Area, 'key' | 'members'>;

const SELECTED_ZOOM = 9;
const FIT_MAX_ZOOM = 8;
const AREA_FIT = { padding: 120, maxZoom: 12, duration: 600 };
const REGROUP_MS = 250;
const ZOOM_STEP = 0.25;

const CLICKABLE_LAYERS = ['pts-auto', 'circles'];

const NONE: ReadonlySet<string> = new Set();

const easeOut = (p: number) => 1 - (1 - p) ** 3;

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** MapLibre reports unwrapped longitudes when world copies are drawn. */
function viewBounds(map: MLMap): ViewBounds {
  const b = map.getBounds();
  const world = b.getEast() - b.getWest() >= 360;
  return {
    west: world ? -180 : wrapLon(b.getWest()),
    south: b.getSouth(),
    east: world ? 180 : wrapLon(b.getEast()),
    north: b.getNorth(),
  };
}

/** Marks every drawn feature holding a hovered or selected place; the ids are what is drawn now. */
function highlight(
  map: MLMap,
  shown: readonly Shown[],
  hovered: ReadonlySet<string>,
  selected: ReadonlySet<string>
) {
  if (!map.getSource('streams')) return;
  map.removeFeatureState({ source: 'streams' });
  for (const { key, members } of shown) {
    if (members.some((m) => hovered.has(m))) {
      map.setFeatureState({ source: 'streams', id: key }, { hover: true });
    }
    if (members.some((m) => selected.has(m))) {
      map.setFeatureState({ source: 'streams', id: key }, { selected: true });
    }
  }
}

export function StreamMap({
  locations,
  className,
  isLoading,
  viewMode = 'circles',
  filterKey,
  serverColorMap,
  isMultiServer,
  hoveredKeys = NONE,
  selectedMembers = NONE,
  onHover,
  onSelect,
  onSelectArea,
  onViewChange,
  fitAllSignal = 0,
}: StreamMapProps) {
  const { t } = useTranslation(['pages']);
  const { accentHue } = useTheme();
  const dark = useResolvedDark();
  const accentH = useAccentH();
  const lang = useMapLang();
  const basemapOk = useBasemapAvailable();
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const savedCamera = useRef<{ center: LngLat; zoom: number } | null>(null);
  const prevMembers = useRef<ReadonlySet<string>>(NONE);
  const fitAllSeen = useRef(fitAllSignal);
  // Starts at the map's opening zoom (useMapLibre's default); zoom events keep it current.
  const zoomRef = useRef(2);
  const shownRef = useRef<readonly Shown[]>([]);
  const highlightRef = useRef({ hovered: NONE, selected: NONE });

  const hasData = locations.length > 0;
  const perServer = Boolean(isMultiServer && serverColorMap);

  const serverColors = useMemo(() => {
    if (!perServer || !serverColorMap) return [];
    const ids = new Set<string>();
    for (const l of locations) for (const s of l.servers ?? []) ids.add(s.serverId);
    return [...ids].map((id) => ({ id, color: serverColorMap.get(id) ?? DEFAULT_SERVER_COLOR }));
  }, [perServer, serverColorMap, locations]);

  const placedLocations = useMemo(() => locations.filter(hasMapPosition), [locations]);
  const areaPoints = useMemo<AreaPoint[]>(
    () =>
      placedLocations.map((l) => ({ key: locationKey(l), lon: l.lon, lat: l.lat, count: l.count })),
    [placedLocations]
  );
  const places = useMemo<Shown[]>(
    () => areaPoints.map((p) => ({ key: p.key, members: [p.key] })),
    [areaPoints]
  );
  const groupAt = useMemo(() => {
    const maxCount = Math.max(...areaPoints.map((p) => p.count), 1);
    const size = perServer ? largestServerCount(placedLocations) : undefined;
    return (zoom: number) => groupIntoAreas(areaPoints, mercatorAt(zoom), maxCount, size);
  }, [areaPoints, perServer, placedLocations]);

  const built = useMemo<{ style: StyleSpecification; areas?: Area[]; zoom: number } | null>(() => {
    if (basemapOk === null) return null;
    // oxlint-disable-next-line react/refs
    const zoom = zoomRef.current;
    const s = buildBaseStyle({ dark, basemapOk, lang, accentH });
    if (!hasData) return { style: s, zoom };

    // The style carries the grouping for the current zoom: a style rebuild diffs the source
    // data, so anything set apart from it would be reverted.
    const areas = viewMode === 'circles' ? groupAt(zoom) : undefined;
    s.sources.streams = {
      type: 'geojson',
      data: locationsGeojson(locations, perServer, areas),
      promoteId: 'key',
    };

    const accentFill = hsl(accentHue, 80, 60);
    const accentStroke = hsl(accentHue, 80, 50);
    const circleColor: ExpressionSpecification | string = perServer
      ? ([
          'match',
          ['get', 'serverId'],
          ...serverColors.flatMap((sc) => [sc.id, sc.color]),
          DEFAULT_SERVER_COLOR,
        ] as unknown as ExpressionSpecification)
      : accentFill;
    const circleStroke = perServer ? circleColor : accentStroke;

    if (viewMode === 'heatmap') {
      const heat = perServer
        ? serverColors.map(({ id, color }) =>
            heatmapLayer(`heat-${id}`, 'streams', colorToHue(color) ?? accentHue, [
              '==',
              ['get', 'serverId'],
              id,
            ])
          )
        : [heatmapLayer('heat', 'streams', accentHue)];
      addDataLayers(
        s,
        ...heat,
        ...crossfadeCircleLayers('streams', circleColor, circleStroke, dark, accentH)
      );
    } else {
      addDataLayers(s, circlesLayer('streams', circleColor, circleStroke));
    }
    return { style: s, areas, zoom };
  }, [
    basemapOk,
    dark,
    lang,
    hasData,
    locations,
    perServer,
    serverColors,
    viewMode,
    accentHue,
    accentH,
    groupAt,
  ]);
  const style = built?.style ?? null;

  const webglOk = isWebglSupported();
  const map = useMapLibre(containerRef, style);

  const byKey = useMemo(() => new Map(locations.map((l) => [locationKey(l), l])), [locations]);
  const hasSelection = selectedMembers.size > 0;
  const [onlySelected] = selectedMembers.size === 1 ? selectedMembers : [];
  const selectedKey = onlySelected ?? null;
  const selected = selectedKey === null ? undefined : byKey.get(selectedKey);
  const selectedLon = selected?.lon ?? null;
  const selectedLat = selected?.lat ?? null;

  const points = useMemo<FitPoint[]>(
    () => placedLocations.map((l) => [l.lon, l.lat, l.count]),
    [placedLocations]
  );
  const fitMissed = useAutoFit(map, points, {
    maxZoom: FIT_MAX_ZOOM,
    filterKey,
    isLoading,
    suspend: hasSelection,
  });
  const selectedZoom = viewMode === 'heatmap' ? HEAT_FADE.end : SELECTED_ZOOM;

  useEffect(() => {
    if (!map || !built) return;
    let areas = built.areas;
    let areasZoom = built.zoom;
    shownRef.current = areas ?? places;
    let pending = 0;
    let frame = 0;
    let drawn: Map<string, PlaceCircle> | null = null;

    const show = (data: FeatureCollection, shown: readonly Shown[]) => {
      void map.getSource<GeoJSONSource>('streams')?.setData(data);
      shownRef.current = shown;
      const { hovered, selected } = highlightRef.current;
      highlight(map, shown, hovered, selected);
    };

    const regroup = (zoom: number) => {
      const prev = areas;
      if (!prev || zoom === areasZoom || !map.getSource('streams')) return;
      areasZoom = zoom;
      const next = groupAt(zoom);
      if (
        JSON.stringify(next.map((a) => a.members)) === JSON.stringify(prev.map((a) => a.members))
      ) {
        return;
      }
      areas = next;
      cancelAnimationFrame(frame);
      const settled = locationsGeojson(locations, perServer, next);
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        drawn = null;
        show(settled, next);
        return;
      }
      const from = drawn ?? placeCircles(locations, perServer, prev);
      const to = placeCircles(locations, perServer, next);
      // Mid-transition a member may be drawn at radius 0 while another carries its circle.
      const targets = next.flatMap((a) => a.members.map((key) => ({ key, members: a.members })));
      let start: number | undefined;
      const step = (now: number) => {
        start ??= now;
        const p = Math.min(1, (now - start) / REGROUP_MS);
        if (p === 1) {
          drawn = null;
          show(settled, next);
          return;
        }
        drawn = lerpCircles(from, to, easeOut(p));
        show(circlesGeojson(drawn), targets);
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    // Mid-zoom the grouping follows quarter steps; once the camera stops it matches the exact zoom.
    const onZoom = () => {
      zoomRef.current = map.getZoom();
      pending ||= requestAnimationFrame(() => {
        pending = 0;
        regroup(Math.round(map.getZoom() / ZOOM_STEP) * ZOOM_STEP);
      });
    };
    const settle = () => {
      cancelAnimationFrame(pending);
      pending = 0;
      regroup(map.getZoom());
    };

    settle();
    map.on('load', settle);
    map.on('zoom', onZoom);
    map.on('moveend', settle);
    return () => {
      map.off('load', settle);
      map.off('zoom', onZoom);
      map.off('moveend', settle);
      cancelAnimationFrame(pending);
      cancelAnimationFrame(frame);
    };
  }, [map, built, places, groupAt, locations, perServer]);

  useEffect(() => {
    if (!map) return;
    if (!hasSelection) {
      if (!fitMissed() && savedCamera.current) {
        map.easeTo({ ...savedCamera.current, duration: 600 });
      }
      savedCamera.current = null;
      return;
    }
    if (selectedLon === null || selectedLat === null) return;
    savedCamera.current ??= { center: map.getCenter(), zoom: map.getZoom() };
    const prev = prevMembers.current;
    // An area fit can sit closer than city zoom; zooming out from it would merge the place back.
    const fromArea = prev.size > 1 && selectedKey !== null && prev.has(selectedKey);
    const zoom = fromArea ? Math.max(selectedZoom, map.getZoom()) : selectedZoom;
    map.easeTo({ center: [selectedLon, selectedLat], zoom, duration: 600 });
  }, [map, hasSelection, selectedKey, selectedLon, selectedLat, selectedZoom, fitMissed]);

  // Runs after the camera effect, so that effect still sees the selection it narrowed from.
  useEffect(() => {
    prevMembers.current = selectedMembers;
  }, [selectedMembers]);

  useEffect(() => {
    if (!map || fitAllSignal === fitAllSeen.current) return;
    fitAllSeen.current = fitAllSignal;
    fitTo(map, points, FIT_MAX_ZOOM);
  }, [map, fitAllSignal, points]);

  useEffect(() => {
    if (!map || !onViewChange) return;
    const report = () => onViewChange(viewBounds(map));
    map.on('load', report);
    map.on('moveend', report);
    return () => {
      map.off('load', report);
      map.off('moveend', report);
    };
  }, [map, onViewChange]);

  useEffect(() => {
    if (!map) return;
    highlightRef.current = { hovered: hoveredKeys, selected: selectedMembers };
    // setStyle rebuilds the source and drops its feature-state, so reapply on every style load.
    const apply = () => highlight(map, shownRef.current, hoveredKeys, selectedMembers);
    apply();
    map.on('styledata', apply);
    return () => {
      map.off('styledata', apply);
    };
  }, [map, hoveredKeys, selectedMembers]);

  useEffect(() => {
    if (!map) return;
    const featureMembers = (e: MapLayerMouseEvent) => {
      const key: unknown = e.features?.[0]?.properties.key;
      if (typeof key !== 'string') return null;
      return { key, members: shownRef.current.find((s) => s.key === key)?.members ?? [key] };
    };
    const move = (e: MapLayerMouseEvent) => {
      const hit = featureMembers(e);
      if (!hit) return;
      map.getCanvas().style.cursor = 'pointer';
      setTooltip({ members: hit.members, x: e.point.x, y: e.point.y });
      onHover?.(hit.members);
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
      setTooltip(null);
      onHover?.(null);
    };
    const click = (e: MapLayerMouseEvent) => {
      const hit = featureMembers(e);
      if (!hit) return;
      if (hit.members.length === 1) {
        onSelect?.(hit.key);
        return;
      }
      onSelectArea?.(hit.members);
      const bounds = autoFitBounds(
        hit.members.flatMap((k): FitPoint[] => {
          const l = byKey.get(k);
          return l && hasMapPosition(l) ? [[l.lon, l.lat]] : [];
        })
      );
      if (!bounds) return;
      savedCamera.current ??= { center: map.getCenter(), zoom: map.getZoom() };
      map.fitBounds(bounds, AREA_FIT);
    };
    for (const layer of CLICKABLE_LAYERS) {
      map.on('mousemove', layer, move);
      map.on('mouseleave', layer, leave);
      map.on('click', layer, click);
    }
    return () => {
      for (const layer of CLICKABLE_LAYERS) {
        map.off('mousemove', layer, move);
        map.off('mouseleave', layer, leave);
        map.off('click', layer, click);
      }
    };
  }, [map, byKey, onHover, onSelect, onSelectArea]);

  const tooltipPlaces = tooltip?.members.flatMap((k) => byKey.get(k) ?? []) ?? [];
  const tooltipLocation = tooltipPlaces[0];

  if (!webglOk) {
    return <MapUnavailable className={className} />;
  }

  return (
    <div className={cn('relative h-full w-full', className)}>
      <div ref={containerRef} className="h-full w-full" />

      {tooltip && tooltipLocation && (
        <div
          className="bg-popover text-popover-foreground pointer-events-none absolute z-10 rounded-md border px-2 py-1 text-xs shadow-md"
          style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}
        >
          {tooltipPlaces.length > 1 ? (
            <>
              <div className="font-medium">
                {t('map.areaName', { name: locationName(tooltipLocation) })}
              </div>
              <div className="text-muted-foreground">
                {t('map.streamsAcrossPlaces', {
                  count: tooltipPlaces.reduce((sum, l) => sum + l.count, 0),
                  places: tooltipPlaces.length,
                })}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium">{locationName(tooltipLocation)}</div>
              <div className="text-muted-foreground">
                {t('map.streamCount', { count: tooltipLocation.count })} ·{' '}
                {t('map.peopleCount', { count: tooltipLocation.peopleCount })}
              </div>
            </>
          )}
        </div>
      )}

      {basemapOk === false && (
        <div className="bg-card/80 text-muted-foreground absolute bottom-2 left-2 rounded-md border px-2 py-1 text-xs backdrop-blur-sm">
          {t('map.basemapMissing')}
        </div>
      )}

      {isLoading && (
        <div className="bg-background/50 absolute inset-0 flex items-center justify-center backdrop-blur-sm">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
            {t('map.loadingData')}
          </div>
        </div>
      )}

      {!isLoading && !hasData && (
        <div className="bg-background/50 absolute inset-0 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">{t('map.noDataForFilters')}</p>
        </div>
      )}
    </div>
  );
}
