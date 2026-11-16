import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AttributionControl, Map as MLMap, NavigationControl, Popup } from 'maplibre-gl';
import type { LngLatLike, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import { useTranslation } from 'react-i18next';
import { recordClientError } from '@/lib/clientErrors';
import { accentPreset, useTheme } from '@/components/theme-provider';
import { autoFitBounds, type FitPoint } from './autoFitBounds';
import { checkBasemap, isWebglSupported, mapMaxZoom, worldFillZoom } from './maplibre';

export function useResolvedDark(): boolean {
  const { theme } = useTheme();
  return theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : theme === 'dark';
}

/** The accent preset's OKLCH hue, which the basemap grays take like the gray tokens do. */
export function useAccentH(): number {
  return accentPreset(useTheme().accentHue).okHue;
}

export function useBasemapAvailable(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void checkBasemap().then((v) => {
      if (live) setOk(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return ok;
}

export function useMapLang(): string {
  const { i18n } = useTranslation();
  return i18n.language?.split('-')[0] ?? 'en';
}

interface UseMapOptions {
  interactive?: boolean;
  navControl?: boolean;
  center?: LngLatLike;
  zoom?: number;
  /** Omitted: the zoom at which one copy of the world fills the map's width, kept current on resize. */
  minZoom?: number;
}

export function useMapLibre(
  containerRef: RefObject<HTMLDivElement | null>,
  style: StyleSpecification | null,
  { interactive = true, navControl = true, center = [0, 20], zoom = 2, minZoom }: UseMapOptions = {}
): MLMap | null {
  const [map, setMap] = useState<MLMap | null>(null);
  const styleRef = useRef(style);
  styleRef.current = style;
  const hasStyle = style !== null;

  useEffect(() => {
    if (!containerRef.current || !styleRef.current || !isWebglSupported()) return;
    const container = containerRef.current;
    const m = new MLMap({
      container,
      style: styleRef.current,
      center,
      zoom,
      minZoom: minZoom ?? worldFillZoom(container.clientWidth),
      maxZoom: mapMaxZoom(),
      interactive,
      attributionControl: false,
      fadeDuration: 200,
    });
    m.addControl(new AttributionControl({ compact: !interactive }));
    if (interactive && navControl) {
      m.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    }
    if (minZoom === undefined) {
      m.on('resize', () => m.setMinZoom(worldFillZoom(container.clientWidth)));
    }
    setMap(m);
    return () => {
      try {
        m.remove();
      } catch (err) {
        recordClientError('maplibre teardown', err);
      }
      setMap(null);
    };
    // Created once when a style first exists; later styles apply via setStyle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, hasStyle]);

  useEffect(() => {
    if (map && style) map.setStyle(style);
  }, [map, style]);

  return map;
}

interface MapPopupProps {
  map: MLMap;
  lngLat: [number, number];
  onClose: () => void;
  children: ReactNode;
}

export function MapPopup({ map, lngLat, onClose, children }: MapPopupProps) {
  const [container] = useState(() => document.createElement('div'));
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [lng, lat] = lngLat;
  useEffect(() => {
    // closeOnClick stays off: the map's pointer-event click fires in the same
    // gesture that opens the popup from a marker and would close it instantly.
    const popup = new Popup({ closeButton: true, closeOnClick: false, maxWidth: '300px' })
      .setLngLat([lng, lat])
      .setDOMContent(container)
      .addTo(map);
    const handleClose = () => onCloseRef.current();
    popup.on('close', handleClose);
    return () => {
      // remove() fires 'close'; detach first or the teardown of one popup
      // clears the state for the next one.
      popup.off('close', handleClose);
      popup.remove();
    };
  }, [map, container, lng, lat]);

  return createPortal(
    <div className="bg-popover text-popover-foreground overflow-hidden rounded-md border shadow-md">
      {children}
    </div>,
    container
  );
}

interface AutoFitOptions {
  maxZoom: number;
  filterKey?: string;
  isLoading?: boolean;
  /** Skip refits while the viewer is engaged, e.g. a popup is open. */
  suspend?: boolean;
}

/**
 * Returns `fitMissed`: when the points changed while suspended, it fits them now and returns
 * true, so a caller restoring its own camera on resume can skip that.
 */
export function useAutoFit(
  map: MLMap | null,
  points: FitPoint[],
  { maxZoom, filterKey, isLoading, suspend }: AutoFitOptions
): () => boolean {
  const prevKeyRef = useRef('');
  const userMovedRef = useRef(false);
  const missedRef = useRef<FitPoint[] | null>(null);

  useEffect(() => {
    if (!map) return;
    const mark = () => {
      userMovedRef.current = true;
    };
    const onZoom = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent) mark();
    };
    map.on('dragstart', mark);
    map.on('zoomstart', onZoom);
    return () => {
      map.off('dragstart', mark);
      map.off('zoomstart', onZoom);
    };
  }, [map]);

  useEffect(() => {
    userMovedRef.current = false;
  }, [filterKey]);

  useEffect(() => {
    if (!map || isLoading || points.length === 0) return;
    const key = points
      .map(([lon, lat]) => `${lat.toFixed(4)},${lon.toFixed(4)}`)
      .sort()
      .join('|');
    if (key === prevKeyRef.current) return;
    const isInitial = prevKeyRef.current === '';
    prevKeyRef.current = key;
    if (suspend && !isInitial) {
      missedRef.current = points;
      return;
    }
    missedRef.current = null;
    if (isInitial || !userMovedRef.current) fitTo(map, points, maxZoom);
  }, [map, points, isLoading, maxZoom, suspend]);

  return useCallback(() => {
    const missed = missedRef.current;
    missedRef.current = null;
    return Boolean(map && missed && fitTo(map, missed, maxZoom));
  }, [map, maxZoom]);
}

export function fitTo(map: MLMap, points: FitPoint[], maxZoom: number): boolean {
  const bounds = autoFitBounds(points);
  if (!bounds) return false;
  map.fitBounds(bounds, { padding: 50, maxZoom, duration: 600 });
  return true;
}
