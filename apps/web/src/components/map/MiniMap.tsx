import { useEffect, useMemo, useRef } from 'react';
import type { StyleSpecification } from 'maplibre-gl';
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

export function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const { accentHue } = useTheme();
  const dark = useResolvedDark();
  const accentH = useAccentH();
  const lang = useMapLang();
  const basemapOk = useBasemapAvailable();
  const containerRef = useRef<HTMLDivElement>(null);

  const style = useMemo<StyleSpecification | null>(() => {
    if (basemapOk === null) return null;
    const s = buildBaseStyle({ dark, basemapOk, lang, accentH });
    s.sources.point = {
      type: 'geojson',
      data: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {},
      },
    };
    addDataLayers(s, {
      id: 'point',
      type: 'circle',
      source: 'point',
      paint: {
        'circle-radius': 8,
        'circle-color': hsl(accentHue, 80, 60),
        'circle-opacity': 0.8,
        'circle-stroke-color': hsl(accentHue, 80, 45),
        'circle-stroke-width': 2,
      },
    });
    return s;
  }, [basemapOk, dark, lang, lat, lon, accentHue, accentH]);

  const map = useMapLibre(containerRef, style, {
    interactive: false,
    center: [lon, lat],
    zoom: 10,
  });

  useEffect(() => {
    map?.jumpTo({ center: [lon, lat], zoom: 10 });
  }, [map, lat, lon]);

  return (
    <div className="h-28 w-full overflow-hidden rounded-lg">
      {isWebglSupported() ? (
        <div ref={containerRef} className="h-full w-full" />
      ) : (
        <MapUnavailable compact />
      )}
    </div>
  );
}
