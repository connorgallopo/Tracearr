import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { AttributionControl, Map as MLMap, NavigationControl, Popup } from 'maplibre-gl';
import type { LngLatLike, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import { useTranslation } from 'react-i18next';
import { recordClientError } from '@/lib/clientErrors';
import { useTheme } from '@/components/theme-provider';
import { checkBasemap, isWebglSupported } from './maplibre';

export function useResolvedDark(): boolean {
  const { theme } = useTheme();
  return theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : theme === 'dark';
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
  minZoom?: number;
}

export function useMapLibre(
  containerRef: RefObject<HTMLDivElement | null>,
  style: StyleSpecification | null,
  {
    interactive = true,
    navControl = true,
    center = [0, 20],
    zoom = 2,
    minZoom = 2,
  }: UseMapOptions = {}
): MLMap | null {
  const [map, setMap] = useState<MLMap | null>(null);
  const styleRef = useRef(style);
  styleRef.current = style;
  const hasStyle = style !== null;

  useEffect(() => {
    if (!containerRef.current || !styleRef.current || !isWebglSupported()) return;
    const m = new MLMap({
      container: containerRef.current,
      style: styleRef.current,
      center,
      zoom,
      minZoom,
      maxZoom: 14,
      interactive,
      attributionControl: false,
      fadeDuration: 200,
    });
    m.addControl(new AttributionControl({ compact: !interactive }));
    if (interactive && navControl) {
      m.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
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

export function useAutoFit(
  map: MLMap | null,
  points: [number, number][],
  { maxZoom, filterKey, isLoading, suspend }: AutoFitOptions
): void {
  const prevKeyRef = useRef('');
  const userMovedRef = useRef(false);

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
    if (suspend && !isInitial) return;
    if (isInitial || !userMovedRef.current) {
      let [minLon, minLat] = points[0]!;
      let [maxLon, maxLat] = points[0]!;
      for (const [lon, lat] of points) {
        minLon = Math.min(minLon, lon);
        minLat = Math.min(minLat, lat);
        maxLon = Math.max(maxLon, lon);
        maxLat = Math.max(maxLat, lat);
      }
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat],
        ],
        { padding: 50, maxZoom, duration: 600 }
      );
    }
  }, [map, points, isLoading, maxZoom, suspend]);
}
