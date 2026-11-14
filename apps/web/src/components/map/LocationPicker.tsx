import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import { useTheme } from '@/components/theme-provider';
import { addDataLayers, buildBaseStyle, hsl, isWebglSupported } from './maplibre';
import { MapUnavailable } from './MapUnavailable';
import {
  useAccentH,
  useBasemapAvailable,
  useMapLang,
  useMapLibre,
  useResolvedDark,
} from './useMapLibre';

export function LocationPicker({
  lat,
  lon,
  onPick,
}: {
  lat: number | null;
  lon: number | null;
  onPick: (lat: number, lon: number) => void;
}) {
  const { t } = useTranslation('pages');
  const { accentHue } = useTheme();
  const dark = useResolvedDark();
  const accentH = useAccentH();
  const lang = useMapLang();
  const basemapOk = useBasemapAvailable();
  const containerRef = useRef<HTMLDivElement>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const pinned = lat !== null && lon !== null;

  const style = useMemo<StyleSpecification | null>(() => {
    if (!basemapOk) return null;
    const s = buildBaseStyle({ dark, basemapOk, lang, accentH });
    if (lat !== null && lon !== null) {
      s.sources.pin = {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {},
        },
      };
      addDataLayers(s, {
        id: 'pin',
        type: 'circle',
        source: 'pin',
        paint: {
          'circle-radius': 7,
          'circle-color': hsl(accentHue, 80, 60),
          'circle-stroke-color': hsl(accentHue, 80, 40),
          'circle-stroke-width': 2,
        },
      });
    }
    return s;
  }, [basemapOk, dark, lang, lat, lon, accentHue, accentH]);

  const map = useMapLibre(containerRef, style, {
    center: pinned ? [lon, lat] : [0, 20],
    zoom: pinned ? 8 : 1,
    minZoom: 1,
  });

  useEffect(() => {
    if (!map) return;
    const handleClick = (e: MapMouseEvent) => {
      const { lat, lng } = e.lngLat.wrap();
      onPickRef.current(lat, lng);
    };
    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
  }, [map]);

  return (
    <div className="h-48 w-full overflow-hidden rounded-lg border">
      {!isWebglSupported() ? (
        <MapUnavailable compact />
      ) : basemapOk === false ? (
        <MapUnavailable compact message={t('map.basemapMissing')} />
      ) : (
        <div ref={containerRef} className="h-full w-full cursor-crosshair" />
      )}
    </div>
  );
}
