import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Marker, type StyleSpecification } from 'maplibre-gl';
import {
  formatEpisodeLabel,
  namesShow,
  isStaff,
  type ActiveSession,
  type LocationStats,
} from '@tracearr/shared';
import { cn, formatLocationCompact, getMediaLinks } from '@/lib/utils';
import { ActiveSessionBadge } from '@/components/sessions/ActiveSessionBadge';
import { LocalBadge } from '@/components/sessions/LocalBadge';
import { MediaPageLink } from '@/components/media/MediaPageLink';
import { ServerLegend } from '@/components/server';
import { User, MapPin } from 'lucide-react';
import { getAvatarUrl } from '@/components/users/utils';
import { useAuth } from '@/hooks/useAuth';
import { buildBaseStyle, DEFAULT_SERVER_COLOR } from './maplibre';
import {
  useAccentH,
  MapPopup,
  useAutoFit,
  useBasemapAvailable,
  useMapLang,
  useMapLibre,
  useResolvedDark,
} from './useMapLibre';

function formatMediaTitle(session: ActiveSession): { primary: string; secondary: string | null } {
  const { mediaType, mediaTitle, seasonNumber, episodeNumber, year } = session;

  if (namesShow(session)) {
    const seasonEp = formatEpisodeLabel(seasonNumber, episodeNumber, { spaced: true });
    return {
      primary: session.grandparentTitle,
      secondary: seasonEp ? `${seasonEp} · ${mediaTitle}` : mediaTitle,
    };
  }

  if (mediaType === 'movie') {
    return { primary: mediaTitle, secondary: year ? `${year}` : null };
  }

  return { primary: mediaTitle, secondary: null };
}

function sessionMarkerElement(color: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'cursor-pointer';
  el.innerHTML = `<div class="relative">
    <div class="absolute -inset-1 animate-ping rounded-full" style="background:${color}50"></div>
    <div class="relative h-4 w-4 rounded-full border-2 border-overlay-foreground shadow-lg" style="background:${color}"></div>
  </div>`;
  return el;
}

function locationMarkerElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'cursor-pointer';
  el.innerHTML = `<div class="h-3 w-3 rounded-full bg-primary border-2 border-overlay-foreground shadow-md"></div>`;
  return el;
}

interface StreamCardProps {
  sessions?: ActiveSession[];
  locations?: LocationStats[];
  className?: string;
  height?: number | string;
  isMultiServer?: boolean;
  serverColorMap?: Map<string, string | null>;
}

type CardPopup =
  | { kind: 'session'; lngLat: [number, number]; session: ActiveSession }
  | { kind: 'location'; lngLat: [number, number]; location: LocationStats };

export function StreamCard({
  sessions,
  locations,
  className,
  height = 300,
  isMultiServer,
  serverColorMap,
}: StreamCardProps) {
  const { t } = useTranslation('common');
  const dark = useResolvedDark();
  const accentH = useAccentH();
  const lang = useMapLang();
  const basemapOk = useBasemapAvailable();
  const containerRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<CardPopup | null>(null);

  const hasData =
    sessions?.some((s) => s.geoLat && s.geoLon) || locations?.some((l) => l.lat && l.lon);

  const legendServers = useMemo(() => {
    if (!sessions) return [];
    const seen = new Map<string, { id: string; name: string; color: string | null }>();
    for (const s of sessions) {
      if (s.server && !seen.has(s.server.id)) {
        seen.set(s.server.id, {
          id: s.server.id,
          name: s.server.name,
          color: serverColorMap?.get(s.server.id) ?? null,
        });
      }
    }
    return [...seen.values()];
  }, [sessions, serverColorMap]);

  const style = useMemo<StyleSpecification | null>(
    () => (basemapOk === null ? null : buildBaseStyle({ dark, basemapOk, lang, accentH })),
    [basemapOk, dark, lang, accentH]
  );

  const map = useMapLibre(containerRef, style);

  const points = useMemo<[number, number][]>(() => {
    const pts: [number, number][] = [];
    sessions?.forEach((s) => {
      if (s.geoLat && s.geoLon) pts.push([s.geoLon, s.geoLat]);
    });
    locations?.forEach((l) => {
      if (l.lat && l.lon) pts.push([l.lon, l.lat]);
    });
    return pts;
  }, [sessions, locations]);
  useAutoFit(map, points, { maxZoom: 10, suspend: popup !== null });

  const markersRef = useRef(new Map<string, { marker: Marker; color?: string }>());
  const dataRef = useRef(new Map<string, CardPopup>());

  // Markers reconcile by key instead of being recreated on every data tick;
  // recreating them mid-click swallows the gesture, since session progress
  // updates land every few seconds.
  useEffect(() => {
    if (!map) return;
    const live = markersRef.current;
    const seen = new Set<string>();

    const upsert = (
      key: string,
      lngLat: [number, number],
      color: string | undefined,
      popup: CardPopup
    ) => {
      seen.add(key);
      dataRef.current.set(key, popup);
      const existing = live.get(key);
      if (existing) {
        existing.marker.setLngLat(lngLat);
        if (color && existing.color !== color) {
          existing.marker.getElement().replaceChildren(...sessionMarkerElement(color).children);
          existing.color = color;
        }
        return;
      }
      const el = color ? sessionMarkerElement(color) : locationMarkerElement();
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const current = dataRef.current.get(key);
        if (current) setPopup(current);
      });
      live.set(key, { marker: new Marker({ element: el }).setLngLat(lngLat).addTo(map), color });
    };

    sessions?.forEach((session) => {
      if (!session.geoLat || !session.geoLon) return;
      const lngLat: [number, number] = [session.geoLon, session.geoLat];
      const color = serverColorMap?.get(session.server.id) ?? DEFAULT_SERVER_COLOR;
      upsert(`s:${session.id}`, lngLat, color, { kind: 'session', lngLat, session });
    });

    locations?.forEach((location) => {
      if (!location.lat || !location.lon) return;
      const lngLat: [number, number] = [location.lon, location.lat];
      upsert(`l:${location.lat},${location.lon}`, lngLat, undefined, {
        kind: 'location',
        lngLat,
        location,
      });
    });

    for (const [key, entry] of live) {
      if (!seen.has(key)) {
        entry.marker.remove();
        live.delete(key);
        dataRef.current.delete(key);
      }
    }
  }, [map, sessions, locations, serverColorMap]);

  useEffect(() => {
    const live = markersRef.current;
    const data = dataRef.current;
    return () => {
      for (const entry of live.values()) entry.marker.remove();
      live.clear();
      data.clear();
    };
  }, [map]);

  return (
    <div className={cn('relative overflow-hidden rounded-lg', className)} style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />

      {map && popup && (
        <MapPopup map={map} lngLat={popup.lngLat} onClose={() => setPopup(null)}>
          {popup.kind === 'session' ? (
            <SessionPopupContent session={popup.session} />
          ) : (
            <LocationPopupContent location={popup.location} />
          )}
        </MapPopup>
      )}

      {!hasData && (
        <div className="bg-background/50 absolute inset-0 flex items-center justify-center">
          <p className="text-muted-foreground text-sm">{t('empty.noLocationData')}</p>
        </div>
      )}

      {isMultiServer && hasData && <ServerLegend variant="floating" servers={legendServers} />}
    </div>
  );
}

function SessionPopupContent({ session }: { session: ActiveSession }) {
  const viewer = useAuth().user;
  const canOpenUser = !!viewer && isStaff(viewer.role);
  const avatarUrl = getAvatarUrl(session.serverId, session.user.thumbUrl, 32);
  const { primary: mediaTitle, secondary: mediaSubtitle } = formatMediaTitle(session);
  const mediaLinks = getMediaLinks(session);

  return (
    <div className="text-foreground min-w-[180px] p-2.5">
      <h4 className="text-sm leading-snug font-semibold">
        <MediaPageLink to={mediaLinks.title}>{mediaTitle}</MediaPageLink>
      </h4>

      <div className="mt-0.5 flex items-center gap-2">
        {mediaSubtitle && (
          <span className="text-muted-foreground truncate text-xs">
            <MediaPageLink to={mediaLinks.subtitle}>{mediaSubtitle}</MediaPageLink>
          </span>
        )}
        <ActiveSessionBadge state={session.state} className="px-1.5 py-0" />
      </div>

      {(() => {
        const name = session.user.identityName ?? session.user.username;
        const body = (
          <>
            <div className="bg-muted flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-full">
              {avatarUrl ? (
                <img src={avatarUrl} alt={name} className="h-5 w-5 object-cover" />
              ) : (
                <User className="text-muted-foreground h-3 w-3" />
              )}
            </div>
            <span className="text-xs font-medium">{name}</span>
          </>
        );
        return canOpenUser ? (
          <Link
            to={`/users/${session.user.id}`}
            className="mt-2 flex items-center gap-2 py-1 transition-opacity hover:opacity-80"
          >
            {body}
          </Link>
        ) : (
          <div className="mt-2 flex items-center gap-2 py-1">{body}</div>
        );
      })()}

      <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
        {(session.geoCity || session.geoCountry) && (
          <>
            <MapPin className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">
              {formatLocationCompact(session.geoCity, session.geoRegion, session.geoCountry)}
            </span>
            <LocalBadge isLocal={session.isLocal} country={session.geoCountry} />
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
  );
}

function LocationPopupContent({ location }: { location: LocationStats }) {
  const { t } = useTranslation(['pages', 'common']);
  return (
    <div className="text-foreground p-3">
      <div className="flex items-center gap-2">
        <MapPin className="text-primary h-4 w-4" />
        <div>
          <p className="font-semibold">{location.city || t('common:labels.unknown')}</p>
          <p className="text-muted-foreground text-xs">{location.country}</p>
        </div>
      </div>
      <div className="border-border mt-2 flex items-center justify-between border-t pt-2 text-sm">
        <span className="text-muted-foreground">{t('map.totalStreams')}</span>
        <span className="font-medium">{location.count}</span>
      </div>
    </div>
  );
}
