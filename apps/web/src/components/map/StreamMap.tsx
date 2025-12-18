import { useEffect, useMemo } from 'react';
import { MapContainer, TileLayer, useMap, ZoomControl, CircleMarker, Popup } from 'react-leaflet';
import { HeatmapLayer } from 'react-leaflet-heatmap-layer-v3';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LocationStats } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/theme-provider';

export type MapViewMode = 'heatmap' | 'circles';

// Custom styles for dark theme, zoom control, and z-index fixes
const mapStyles = `
  /* Ensure map container doesn't overlap sidebars/modals */
  .leaflet-container {
    z-index: 0 !important;
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
}

// Heatmap configuration optimized for streaming location data
const HEATMAP_CONFIG = {
  // Gradient: dark cyan base → bright cyan → white hotspots
  // Designed for dark map tiles with good contrast
  gradient: {
    0.0: 'rgba(14, 116, 144, 0)', // cyan-700 transparent (fade from nothing)
    0.2: 'rgba(14, 116, 144, 0.8)', // cyan-700
    0.4: '#0891b2', // cyan-600
    0.6: '#06b6d4', // cyan-500
    0.8: '#22d3ee', // cyan-400
    0.95: '#67e8f9', // cyan-300
    1.0: '#ffffff', // white for hotspots
  },
  // Radius: larger for world view, heatmap auto-adjusts with zoom
  radius: 30,
  // Blur: soft edges for smooth transitions
  blur: 20,
  // minOpacity: ensure even low-activity areas are visible
  minOpacity: 0.4,
  // maxZoom: heatmap intensity calculation stops scaling at this zoom
  maxZoom: 12,
};

// Circle markers layer component
function CircleMarkersLayer({ locations }: { locations: LocationStats[] }) {
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

  return (
    <>
      {locations
        .filter((l) => l.lat && l.lon)
        .map((location, index) => (
          <CircleMarker
            key={`${location.lat}-${location.lon}-${index}`}
            center={[location.lat, location.lon]}
            radius={getRadius(location.count)}
            pathOptions={{
              color: '#06b6d4', // cyan-500
              fillColor: '#22d3ee', // cyan-400
              fillOpacity: getOpacity(location.count),
              weight: 1,
            }}
          >
            <Popup>
              <div className="text-sm">
                <div className="font-semibold">
                  {location.city ? `${location.city}, ` : ''}
                  {location.country || 'Unknown'}
                </div>
                <div className="text-muted-foreground">
                  {location.count.toLocaleString()} stream{location.count !== 1 ? 's' : ''}
                </div>
              </div>
            </Popup>
          </CircleMarker>
        ))}
    </>
  );
}

// Component to fit bounds when data changes
function MapBoundsUpdater({
  locations,
  isLoading,
}: {
  locations: LocationStats[];
  isLoading?: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    // Don't update bounds while loading - prevents zoom reset during filter changes
    if (isLoading) return;

    const points: [number, number][] = locations
      .filter((l) => l.lat && l.lon)
      .map((l) => [l.lat, l.lon]);

    if (points.length > 0) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 8 });
    }
    // Note: Don't zoom out when no data - preserve current view during filter transitions
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
}: StreamMapProps) {
  const hasData = locations.length > 0;
  const { theme } = useTheme();
  const resolvedTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  const tileUrl = TILE_URLS[resolvedTheme];

  return (
    <div className={cn('relative h-full w-full', className)}>
      <style>{mapStyles}</style>
      <MapContainer
        center={[20, 0]}
        zoom={2}
        className="h-full w-full"
        scrollWheelZoom={true}
        zoomControl={false}
      >
        <TileLayer
          key={resolvedTheme}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={tileUrl}
        />
        <ZoomControl position="bottomright" />

        <MapBoundsUpdater locations={locations} isLoading={isLoading} />

        {/* Visualization layer - heatmap or circles */}
        {hasData && viewMode === 'heatmap' && (
          <HeatmapLayer
            points={locations.filter((l) => l.lat && l.lon)}
            latitudeExtractor={(l: LocationStats) => l.lat}
            longitudeExtractor={(l: LocationStats) => l.lon}
            // Logarithmic intensity: prevents high-count locations from dominating
            intensityExtractor={(l: LocationStats) => Math.log10(l.count + 1)}
            gradient={HEATMAP_CONFIG.gradient}
            radius={HEATMAP_CONFIG.radius}
            blur={HEATMAP_CONFIG.blur}
            minOpacity={HEATMAP_CONFIG.minOpacity}
            maxZoom={HEATMAP_CONFIG.maxZoom}
            // Dynamic max based on log scale
            max={Math.log10(Math.max(...locations.map((l) => l.count), 1) + 1)}
          />
        )}
        {hasData && viewMode === 'circles' && <CircleMarkersLayer locations={locations} />}
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
