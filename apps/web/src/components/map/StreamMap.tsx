import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DataDrivenPropertyValueSpecification,
  ExpressionSpecification,
  MapLayerMouseEvent,
  StyleSpecification,
} from 'maplibre-gl';
import { useTranslation } from 'react-i18next';
import type { LocationStats } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/theme-provider';
import { MapUnavailable } from './MapUnavailable';
import {
  buildBaseStyle,
  colorToHue,
  crossfadeCircleLayers,
  DEFAULT_SERVER_COLOR,
  heatmapLayer,
  hsl,
  isWebglSupported,
  locationsGeojson,
  type LocationFeatureProps,
} from './maplibre';
import {
  MapPopup,
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
  serverNameMap?: Record<string, string>;
  isMultiServer?: boolean;
}

interface PopupState {
  lngLat: [number, number];
  props: LocationFeatureProps;
}

const CLICKABLE_LAYERS = ['pts-auto', 'circles'];

export function StreamMap({
  locations,
  className,
  isLoading,
  viewMode = 'heatmap',
  filterKey,
  serverColorMap,
  serverNameMap,
  isMultiServer,
}: StreamMapProps) {
  const { t } = useTranslation(['pages']);
  const { accentHue } = useTheme();
  const dark = useResolvedDark();
  const lang = useMapLang();
  const basemapOk = useBasemapAvailable();
  const containerRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<PopupState | null>(null);

  const hasData = locations.length > 0;
  const perServer = Boolean(isMultiServer && serverColorMap);

  const serverColors = useMemo(() => {
    if (!perServer || !serverColorMap) return [];
    const ids = new Set<string>();
    for (const l of locations) for (const s of l.servers ?? []) ids.add(s.serverId);
    return [...ids].map((id) => ({ id, color: serverColorMap.get(id) ?? DEFAULT_SERVER_COLOR }));
  }, [perServer, serverColorMap, locations]);

  const style = useMemo<StyleSpecification | null>(() => {
    if (basemapOk === null) return null;
    const s = buildBaseStyle({ dark, basemapOk, lang });
    if (!hasData) return s;

    s.sources.streams = { type: 'geojson', data: locationsGeojson(locations, perServer) };

    const accentFill = hsl(accentHue, 80, 60);
    const accentStroke = hsl(accentHue, 80, 50);
    const circleColor: DataDrivenPropertyValueSpecification<string> = perServer
      ? ([
          'match',
          ['get', 'serverId'],
          ...serverColors.flatMap((sc) => [sc.id, sc.color]),
          DEFAULT_SERVER_COLOR,
        ] as unknown as ExpressionSpecification)
      : accentFill;
    const circleStroke = perServer ? circleColor : accentStroke;

    if (viewMode === 'heatmap') {
      if (perServer) {
        for (const { id, color } of serverColors) {
          s.layers.push(
            heatmapLayer(`heat-${id}`, 'streams', colorToHue(color) ?? accentHue, [
              '==',
              ['get', 'serverId'],
              id,
            ])
          );
        }
      } else {
        s.layers.push(heatmapLayer('heat', 'streams', accentHue));
      }
      s.layers.push(...crossfadeCircleLayers('streams', circleColor, circleStroke, dark));
    } else {
      s.layers.push({
        id: 'circles',
        type: 'circle',
        source: 'streams',
        paint: {
          'circle-radius': ['+', 6, ['*', 19, ['get', 'w']]],
          'circle-color': circleColor,
          'circle-stroke-color': circleStroke,
          'circle-stroke-width': 1,
          'circle-opacity': ['+', 0.4, ['*', 0.4, ['get', 'w']]],
          'circle-stroke-opacity': 0.9,
        },
      });
    }
    return s;
  }, [basemapOk, dark, lang, hasData, locations, perServer, serverColors, viewMode, accentHue]);

  const webglOk = isWebglSupported();
  const map = useMapLibre(containerRef, style);

  const points = useMemo<[number, number][]>(
    () => locations.filter((l) => l.lat && l.lon).map((l) => [l.lon, l.lat]),
    [locations]
  );
  useAutoFit(map, points, { maxZoom: 8, filterKey, isLoading, suspend: popup !== null });

  const onClick = useCallback((e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    if (!f) return;
    setPopup({
      lngLat: [e.lngLat.lng, e.lngLat.lat],
      props: f.properties as LocationFeatureProps,
    });
  }, []);

  useEffect(() => {
    if (!map) return;
    const enter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      map.getCanvas().style.cursor = '';
    };
    for (const layer of CLICKABLE_LAYERS) {
      map.on('click', layer, onClick);
      map.on('mouseenter', layer, enter);
      map.on('mouseleave', layer, leave);
    }
    return () => {
      for (const layer of CLICKABLE_LAYERS) {
        map.off('click', layer, onClick);
        map.off('mouseenter', layer, enter);
        map.off('mouseleave', layer, leave);
      }
    };
  }, [map, onClick]);

  if (!webglOk) {
    return <MapUnavailable className={className} />;
  }

  return (
    <div className={cn('relative h-full w-full', className)}>
      <div ref={containerRef} className="h-full w-full" />

      {map && popup && (
        <MapPopup map={map} lngLat={popup.lngLat} onClose={() => setPopup(null)}>
          <LocationPopupContent
            props={popup.props}
            serverNameMap={serverNameMap}
            showServers={perServer}
          />
        </MapPopup>
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
            Loading map data...
          </div>
        </div>
      )}

      {!isLoading && !hasData && (
        <div className="bg-background/50 absolute inset-0 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">No location data for current filters</p>
        </div>
      )}
    </div>
  );
}

function LocationPopupContent({
  props,
  serverNameMap,
  showServers,
}: {
  props: LocationFeatureProps;
  serverNameMap?: Record<string, string>;
  showServers: boolean;
}) {
  const servers = props.servers ?? [];
  const showBreakdown = showServers && serverNameMap && servers.length > 1;
  return (
    <div className="text-sm">
      <div className="font-semibold">
        {props.city ? `${props.city}, ` : ''}
        {props.country || 'Unknown'}
      </div>
      <div className="text-muted-foreground">
        {props.count.toLocaleString()} stream{props.count !== 1 ? 's' : ''}
      </div>
      {showBreakdown && (
        <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
          {servers.map((entry) => (
            <div key={entry.serverId} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">
                {serverNameMap[entry.serverId] ?? entry.serverId}
              </span>
              <span className="tabular-nums">{entry.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
