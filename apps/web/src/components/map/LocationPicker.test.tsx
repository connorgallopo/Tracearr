import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LngLat, type LayerSpecification, type StyleSpecification } from 'maplibre-gl';
import { LocationPicker } from './LocationPicker';

const handlers: Record<string, (event: unknown) => void> = {};
const fakeMap = {
  on: vi.fn((event: string, handler: (event: unknown) => void) => {
    handlers[event] = handler;
  }),
  off: vi.fn(),
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ accentHue: 200 }) }));
vi.mock('./maplibre', () => ({
  addDataLayers: (s: StyleSpecification, ...layers: LayerSpecification[]) =>
    s.layers.push(...layers),
  buildBaseStyle: () => ({ version: 8, sources: {}, layers: [] }),
  hsl: () => 'hsl(200, 80%, 60%)',
  isWebglSupported: () => true,
}));
vi.mock('./useMapLibre', () => ({
  useResolvedDark: () => false,
  useAccentH: () => 212,
  useMapLang: () => 'en',
  useBasemapAvailable: vi.fn(() => true),
  useMapLibre: () => fakeMap,
}));

import { useBasemapAvailable } from './useMapLibre';

describe('LocationPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useBasemapAvailable).mockReturnValue(true);
  });

  it('wraps a click on a world copy back into range', () => {
    const onPick = vi.fn();
    render(<LocationPicker lat={null} lon={null} onPick={onPick} />);

    handlers.click?.({ lngLat: new LngLat(252.5, 10) });

    expect(onPick).toHaveBeenCalledWith(10, -107.5);
  });

  it('shows the missing basemap instead of an empty map', () => {
    vi.mocked(useBasemapAvailable).mockReturnValue(false);
    const { container } = render(<LocationPicker lat={null} lon={null} onPick={vi.fn()} />);

    expect(screen.getByText('map.basemapMissing')).toBeInTheDocument();
    expect(container.querySelector('.cursor-crosshair')).toBeNull();
  });
});
