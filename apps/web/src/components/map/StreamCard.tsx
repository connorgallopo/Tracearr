import { useEffect } from 'react';
import { Link } from 'react-router';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { ActiveSession, LocationStats } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { ActiveSessionBadge } from '@/components/sessions/ActiveSessionBadge';
import { useTheme } from '@/components/theme-provider';
import { User, MapPin } from 'lucide-react';
import { getAvatarUrl } from '@/components/users/utils';

// Fix for default marker icons in Leaflet with bundlers
delete (L.Icon.Default.prototype as { _getIconUrl?: () => void })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Custom marker icon for active sessions
const activeSessionIcon = L.divIcon({
  className: 'stream-marker',
  html: `<div class="relative">
    <div class="absolute -inset-1 animate-ping rounded-full bg-green-500/50"></div>
    <div class="relative h-4 w-4 rounded-full bg-green-500 border-2 border-white shadow-lg"></div>
  </div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
  popupAnchor: [0, -10],
});

// Location marker icon
const locationIcon = L.divIcon({
  className: 'location-marker',
  html: `<div class="h-3 w-3 rounded-full bg-blue-500 border-2 border-white shadow-md"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
  popupAnchor: [0, -8],
});

// Format media title based on type
function formatMediaTitle(session: ActiveSession): { primary: string; secondary: string | null } {
  const { mediaType, mediaTitle, grandparentTitle, seasonNumber, episodeNumber, year } = session;

  if (mediaType === 'episode' && grandparentTitle) {
    const seasonEp =
      seasonNumber && episodeNumber
        ? `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`
        : null;
    return {
      primary: grandparentTitle,
      secondary: seasonEp ? `${seasonEp} · ${mediaTitle}` : mediaTitle,
    };
  }

  if (mediaType === 'movie') {
    return { primary: mediaTitle, secondary: year ? `${year}` : null };
  }

  return { primary: mediaTitle, secondary: null };
}

// Custom styles for popup and z-index fixes
const popupStyles = `
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
  .leaflet-popup-content-wrapper {
    background: hsl(var(--card));
    border: 1px solid hsl(var(--border));
    border-radius: 0.5rem;
    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
    padding: 0;
  }
  .leaflet-popup-content {
    margin: 0 !important;
    min-width: 220px;
    max-width: 280px;
  }
  .leaflet-popup-tip {
    background: hsl(var(--card));
    border: 1px solid hsl(var(--border));
    border-top: none;
    border-right: none;
  }
  .leaflet-popup-close-button {
    color: hsl(var(--muted-foreground)) !important;
    font-size: 18px !important;
    padding: 4px 8px !important;
  }
  .leaflet-popup-close-button:hover {
    color: hsl(var(--foreground)) !important;
  }
`;

interface StreamCardProps {
  sessions?: ActiveSession[];
  locations?: LocationStats[];
  className?: string;
  height?: number | string;
}

// Component to fit bounds when data changes
function MapBoundsUpdater({
  sessions,
  locations,
}: {
  sessions?: ActiveSession[];
  locations?: LocationStats[];
}) {
  const map = useMap();

  useEffect(() => {
    const points: [number, number][] = [];

    sessions?.forEach((s) => {
      if (s.geoLat && s.geoLon) {
        points.push([s.geoLat, s.geoLon]);
      }
    });

    locations?.forEach((l) => {
      if (l.lat && l.lon) {
        points.push([l.lat, l.lon]);
      }
    });

    if (points.length > 0) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
    }
  }, [sessions, locations, map]);

  return null;
}

// Map tile URLs for different themes
const TILE_URLS = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

export function StreamCard({ sessions, locations, className, height = 300 }: StreamCardProps) {
  const hasData =
    sessions?.some((s) => s.geoLat && s.geoLon) || locations?.some((l) => l.lat && l.lon);
  const { theme } = useTheme();
  const resolvedTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  const tileUrl = TILE_URLS[resolvedTheme];

  return (
    <div className={cn('relative overflow-hidden rounded-lg', className)} style={{ height }}>
      <style>{popupStyles}</style>
      <MapContainer
        center={[20, 0]}
        zoom={2}
        className="h-full w-full"
        scrollWheelZoom={true}
        zoomControl={true}
      >
        <TileLayer
          key={resolvedTheme}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url={tileUrl}
        />

        <MapBoundsUpdater sessions={sessions} locations={locations} />

        {/* Active session markers */}
        {sessions?.map((session) => {
          if (!session.geoLat || !session.geoLon) return null;

          const avatarUrl = getAvatarUrl(session.serverId, session.user.thumbUrl, 32);
          const { primary: mediaTitle, secondary: mediaSubtitle } = formatMediaTitle(session);

          return (
            <Marker
              key={session.id}
              position={[session.geoLat, session.geoLon]}
              icon={activeSessionIcon}
            >
              <Popup>
                <div className="text-foreground min-w-[180px] p-2.5">
                  {/* Media title */}
                  <h4 className="text-sm leading-snug font-semibold">{mediaTitle}</h4>

                  {/* Subtitle + status on same line */}
                  <div className="mt-0.5 flex items-center gap-2">
                    {mediaSubtitle && (
                      <span className="text-muted-foreground truncate text-xs">
                        {mediaSubtitle}
                      </span>
                    )}
                    <ActiveSessionBadge state={session.state} className="px-1.5 py-0 text-[10px]" />
                  </div>

                  {/* User - clickable */}
                  <Link
                    to={`/users/${session.user.id}`}
                    className="mt-2 flex items-center gap-2 py-1 transition-opacity hover:opacity-80"
                  >
                    <div className="bg-muted flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
                      {avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt={session.user.username}
                          className="h-5 w-5 object-cover"
                        />
                      ) : (
                        <User className="text-muted-foreground h-3 w-3" />
                      )}
                    </div>
                    <span className="text-xs font-medium">
                      {session.user.identityName ?? session.user.username}
                    </span>
                  </Link>

                  {/* Meta info */}
                  <div className="text-muted-foreground mt-1 flex items-center gap-2 text-[11px]">
                    {(session.geoCity || session.geoCountry) && (
                      <>
                        <MapPin className="h-3 w-3 flex-shrink-0" />
                        <span className="truncate">{session.geoCity || session.geoCountry}</span>
                      </>
                    )}
                    {(session.product || session.platform) && (
                      <>
                        <span className="text-border">·</span>
                        <span className="truncate">{session.product || session.platform}</span>
                      </>
                    )}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* Location stats markers */}
        {locations?.map((location, idx) => {
          if (!location.lat || !location.lon) return null;

          return (
            <Marker
              key={`${location.city}-${location.country}-${idx}`}
              position={[location.lat, location.lon]}
              icon={locationIcon}
            >
              <Popup>
                <div className="text-foreground p-3">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-blue-500" />
                    <div>
                      <p className="font-semibold">{location.city || 'Unknown'}</p>
                      <p className="text-muted-foreground text-xs">{location.country}</p>
                    </div>
                  </div>
                  <div className="border-border mt-2 flex items-center justify-between border-t pt-2 text-sm">
                    <span className="text-muted-foreground">Total streams</span>
                    <span className="font-medium">{location.count}</span>
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      {!hasData && (
        <div className="bg-background/50 absolute inset-0 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">No location data available</p>
        </div>
      )}
    </div>
  );
}
