import { useCallback, useEffect, useMemo, useRef } from 'react';
import { MapContainer, TileLayer, useMap, ZoomControl, CircleMarker, Popup } from 'react-leaflet';
import { HeatmapLayer } from 'react-leaflet-heatmap-layer-v3';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LocationStats } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/theme-provider';

export type MapViewMode = 'heatmap' | 'circles';

/**
 * Generate HSL color string from hue, saturation, and lightness values
 */
function hsl(h: number, s: number, l: number, a?: number): string {
  if (a !== undefined) {
    return `hsla(${h}, ${s}%, ${l}%, ${a})`;
  }
  return `hsl(${h}, ${s}%, ${l}%)`;
}

/**
 * Generate a heatmap gradient based on the accent hue
 * Transitions from transparent -> accent color -> white hotspots
 */
function generateHeatmapGradient(hue: number): Record<number, string> {
  return {
    0.0: hsl(hue, 85, 31, 0), // transparent (fade from nothing)
    0.2: hsl(hue, 85, 31, 0.8), // dark accent
    0.4: hsl(hue, 86, 42), // medium-dark accent
    0.6: hsl(hue, 80, 50), // core accent
    0.8: hsl(hue, 80, 60), // lighter accent
    0.95: hsl(hue, 80, 70), // very light accent
    1.0: '#ffffff', // white for hotspots
  };
}

/**
 * Generate circle marker colors based on the accent hue
 */
function generateCircleColors(hue: number): { stroke: string; fill: string } {
  return {
    stroke: hsl(hue, 80, 50), // core accent for border
    fill: hsl(hue, 80, 60), // lighter accent for fill
  };
}

// Custom styles for dark theme, zoom control, and z-index fixes
const mapStyles = `
  /* Ensure map container doesn't overlap sidebars/modals */
  .leaflet-container {
    z-index: 0 !important;
    background: hsl(var(--background)) !important;
  }
  .leaflet-pane {
    z-index: 1 !important;
  }
  .leaflet-tile-pane {
    z-index: 1 !important;
  }
  .leaflet-overlay-pane {
    z-index: 2 !important;
  }
  .leaflet-marker-pane {
    z-index: 3 !important;
  }
  .leaflet-tooltip-pane {
    z-index: 4 !important;
  }
  .leaflet-popup-pane {
    z-index: 5 !important;
  }
  .leaflet-control {
    z-index: 10 !important;
  }
  .leaflet-control-zoom {
    border: 1px solid hsl(var(--border)) !important;
    border-radius: 0.5rem !important;
    overflow: hidden;
  }
  .leaflet-control-zoom a {
    background: hsl(var(--card)) !important;
    color: hsl(var(--foreground)) !important;
    border-bottom: 1px solid hsl(var(--border)) !important;
  }
  .leaflet-control-zoom a:hover {
    background: hsl(var(--muted)) !important;
  }
  .leaflet-control-zoom a:last-child {
    border-bottom: none !important;
  }
`;

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

// Heatmap configuration (gradient generated dynamically from accent color)
const HEATMAP_CONFIG = {
  // Radius: larger for world view, heatmap auto-adjusts with zoom
  radius: 30,
  // Blur: soft edges for smooth transitions
  blur: 20,
  // minOpacity: ensure even low-activity areas are visible
  minOpacity: 0.4,
  // maxZoom: heatmap intensity calculation stops scaling at this zoom
  maxZoom: 12,
};

// Default green used when no server color is assigned
const DEFAULT_STROKE = 'hsl(142, 76%, 42%)';
const DEFAULT_FILL = 'hsl(142, 76%, 55%)';

interface CircleMarkersLayerProps {
  locations: LocationStats[];
  colors: { stroke: string; fill: string };
  serverColorMap?: Map<string, string | null>;
  serverNameMap?: Record<string, string>;
  isMultiServer?: boolean;
}

interface LocationPopupContentProps {
  location: LocationStats;
  serverBreakdown?: { serverId: string; count: number }[];
  serverNameMap?: Record<string, string>;
}

/**
 * Body of a location marker popup.
 *
 * One marker can cover several people, because GeoIP resolves every address in
 * a city to the same coordinates. /stats/locations already returns the accounts
 * and the unique device count behind each marker, so both are listed here to
 * make a shared location readable.
 *
 * Exported for tests: Leaflet mounts popup children only once the popup opens,
 * which a jsdom render cannot drive.
 */
export function LocationPopupContent({
  location,
  serverBreakdown,
  serverNameMap,
}: LocationPopupContentProps) {
  const users = location.users ?? [];
  const deviceCount = location.deviceCount ?? 0;

  return (
    <div className="text-sm">
      <div className="font-semibold">
        {location.city ? `${location.city}, ` : ''}
        {location.country || 'Unknown'}
      </div>
      <div className="text-muted-foreground">
        {location.count.toLocaleString()} stream{location.count !== 1 ? 's' : ''}
        {deviceCount > 0 && (
          <>
            {' from '}
            {deviceCount.toLocaleString()} device{deviceCount !== 1 ? 's' : ''}
          </>
        )}
      </div>
      {users.length > 0 && (
        <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
          {users.map((user) => (
            <div key={user.id} className="text-muted-foreground">
              {user.username}
            </div>
          ))}
        </div>
      )}
      {serverBreakdown && serverNameMap && (
        <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
          {serverBreakdown.map((entry) => (
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

// Circle markers layer component
function CircleMarkersLayer({
  locations,
  colors,
  serverColorMap,
  serverNameMap,
  isMultiServer,
}: CircleMarkersLayerProps) {
  const maxCount = useMemo(() => Math.max(...locations.map((l) => l.count), 1), [locations]);

  // Calculate radius based on count (scaled logarithmically)
  const getRadius = (count: number) => {
    const minRadius = 6;
    const maxRadius = 25;
    const scale = Math.log(count + 1) / Math.log(maxCount + 1);
    return minRadius + scale * (maxRadius - minRadius);
  };

  // Get opacity based on count
  const getOpacity = (count: number) => {
    const minOpacity = 0.4;
    const maxOpacity = 0.8;
    const scale = count / maxCount;
    return minOpacity + scale * (maxOpacity - minOpacity);
  };

  // Resolve marker color from the dominant server, falling back to accent colors
  const getMarkerColors = (location: LocationStats): { stroke: string; fill: string } => {
    if (!isMultiServer || !serverColorMap) return colors;
    const dominantServerId = location.servers?.[0]?.serverId;
    if (!dominantServerId) return colors;
    const serverColor = serverColorMap.get(dominantServerId);
    if (!serverColor) return { stroke: DEFAULT_STROKE, fill: DEFAULT_FILL };
    return { stroke: serverColor, fill: serverColor };
  };

  return (
    <>
      {locations
        .filter((l) => l.lat && l.lon)
        .map((location, index) => {
          const markerColors = getMarkerColors(location);
          const serverBreakdown =
            isMultiServer && serverNameMap && (location.servers?.length ?? 0) > 1
              ? location.servers
              : undefined;

          return (
            <CircleMarker
              key={`${location.lat}-${location.lon}-${index}`}
              center={[location.lat, location.lon]}
              radius={getRadius(location.count)}
              pathOptions={{
                color: markerColors.stroke,
                fillColor: markerColors.fill,
                fillOpacity: getOpacity(location.count),
                weight: 1,
              }}
            >
              <Popup>
                <LocationPopupContent
                  location={location}
                  serverBreakdown={serverBreakdown}
                  serverNameMap={serverNameMap}
                />
              </Popup>
            </CircleMarker>
          );
        })}
    </>
  );
}

function MapBoundsUpdater({
  locations,
  isLoading,
  filterKey,
}: {
  locations: LocationStats[];
  isLoading?: boolean;
  filterKey?: string;
}) {
  const map = useMap();
  const prevBoundsKeyRef = useRef<string>('');
  const userInteractedRef = useRef(false);
  const isProgrammaticRef = useRef(false);

  const handleUserInteraction = useCallback(() => {
    if (!isProgrammaticRef.current) {
      userInteractedRef.current = true;
    }
  }, []);

  useEffect(() => {
    map.on('zoomstart', handleUserInteraction);
    map.on('dragstart', handleUserInteraction);
    return () => {
      map.off('zoomstart', handleUserInteraction);
      map.off('dragstart', handleUserInteraction);
    };
  }, [map, handleUserInteraction]);

  useEffect(() => {
    userInteractedRef.current = false;
  }, [filterKey]);

  useEffect(() => {
    if (isLoading) return;

    const points: [number, number][] = locations
      .filter((l) => l.lat && l.lon)
      .map((l) => [l.lat, l.lon]);

    if (points.length === 0) return;

    const boundsKey = points
      .map(([lat, lon]) => `${lat.toFixed(4)},${lon.toFixed(4)}`)
      .sort()
      .join('|');

    if (boundsKey === prevBoundsKeyRef.current) return;

    const isInitialLoad = prevBoundsKeyRef.current === '';
    prevBoundsKeyRef.current = boundsKey;

    if (isInitialLoad || !userInteractedRef.current) {
      const bounds = L.latLngBounds(points);
      isProgrammaticRef.current = true;
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 8 });
      isProgrammaticRef.current = false;
    }
  }, [locations, map, isLoading]);

  return null;
}

// Map tile URLs for different themes
const TILE_URLS = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

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
  const hasData = locations.length > 0;
  const { theme, accentHue } = useTheme();
  const resolvedTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  const tileUrl = TILE_URLS[resolvedTheme];

  // Generate accent-colored gradient and circle colors
  const heatmapGradient = useMemo(() => generateHeatmapGradient(accentHue), [accentHue]);
  const circleColors = useMemo(() => generateCircleColors(accentHue), [accentHue]);

  return (
    <div className={cn('relative h-full w-full', className)}>
      <style>{mapStyles}</style>
      <MapContainer
        center={[20, 0]}
        zoom={2}
        minZoom={2}
        maxBounds={[
          [-85, -180],
          [85, 180],
        ]}
        maxBoundsViscosity={1.0}
        worldCopyJump={false}
        className="h-full w-full"
        scrollWheelZoom={true}
        zoomControl={false}
      >
        <TileLayer
          key={resolvedTheme}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={tileUrl}
          noWrap={true}
        />
        <ZoomControl position="bottomright" />

        <MapBoundsUpdater locations={locations} isLoading={isLoading} filterKey={filterKey} />

        {/* Visualization layer - heatmap or circles */}
        {hasData && viewMode === 'heatmap' && (
          <HeatmapLayer
            points={locations.filter((l) => l.lat && l.lon)}
            latitudeExtractor={(l: LocationStats) => l.lat}
            longitudeExtractor={(l: LocationStats) => l.lon}
            // Logarithmic intensity: prevents high-count locations from dominating
            intensityExtractor={(l: LocationStats) => Math.log10(l.count + 1)}
            gradient={heatmapGradient}
            radius={HEATMAP_CONFIG.radius}
            blur={HEATMAP_CONFIG.blur}
            minOpacity={HEATMAP_CONFIG.minOpacity}
            maxZoom={HEATMAP_CONFIG.maxZoom}
            // Dynamic max based on log scale
            max={Math.log10(Math.max(...locations.map((l) => l.count), 1) + 1)}
          />
        )}
        {hasData && viewMode === 'circles' && (
          <CircleMarkersLayer
            locations={locations}
            colors={circleColors}
            serverColorMap={serverColorMap}
            serverNameMap={serverNameMap}
            isMultiServer={isMultiServer}
          />
        )}
      </MapContainer>

      {/* Loading overlay */}
      {isLoading && (
        <div className="bg-background/50 absolute inset-0 flex items-center justify-center backdrop-blur-sm">
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
            Loading map data...
          </div>
        </div>
      )}

      {/* No data message */}
      {!isLoading && !hasData && (
        <div className="bg-background/50 absolute inset-0 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">No location data for current filters</p>
        </div>
      )}
    </div>
  );
}
