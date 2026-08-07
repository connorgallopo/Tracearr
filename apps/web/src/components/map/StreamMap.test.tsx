import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LocationStats } from '@tracearr/shared';

// Leaflet needs a real map container, and none of it is involved in the popup
// body under test, so the map primitives are stubbed at import time.
vi.mock('react-leaflet', () => ({
  MapContainer: () => null,
  TileLayer: () => null,
  useMap: () => ({ on: vi.fn(), off: vi.fn(), fitBounds: vi.fn() }),
  ZoomControl: () => null,
  CircleMarker: () => null,
  Popup: () => null,
}));

vi.mock('react-leaflet-heatmap-layer-v3', () => ({
  HeatmapLayer: () => null,
}));

import { LocationPopupContent } from './StreamMap';

function makeLocation(overrides: Partial<LocationStats> = {}): LocationStats {
  return {
    city: 'Porto Alegre',
    region: 'Rio Grande do Sul',
    country: 'BR',
    lat: -30.1188,
    lon: -51.168,
    count: 3,
    ...overrides,
  };
}

describe('LocationPopupContent', () => {
  it('lists every account behind a shared marker', () => {
    // GeoIP resolves every address in a city to the same coordinates, so two
    // different people collapse into one marker. Both have to be readable.
    render(
      <LocationPopupContent
        location={makeLocation({
          users: [
            { id: 'u1', username: 'conradir', thumbUrl: null },
            { id: 'u2', username: 'bruxao', thumbUrl: null },
          ],
          deviceCount: 2,
        })}
      />
    );

    expect(screen.getByText('conradir')).toBeInTheDocument();
    expect(screen.getByText('bruxao')).toBeInTheDocument();
  });

  it('reports the unique device count next to the stream count', () => {
    render(
      <LocationPopupContent
        location={makeLocation({
          count: 3,
          users: [{ id: 'u1', username: 'conradir', thumbUrl: null }],
          deviceCount: 2,
        })}
      />
    );

    expect(screen.getByText(/3 streams from 2 devices/)).toBeInTheDocument();
  });

  it('singularises a marker holding one stream on one device', () => {
    render(
      <LocationPopupContent
        location={makeLocation({
          count: 1,
          users: [{ id: 'u1', username: 'conradir', thumbUrl: null }],
          deviceCount: 1,
        })}
      />
    );

    expect(screen.getByText(/1 stream from 1 device/)).toBeInTheDocument();
  });

  it('omits the device count when the API does not send one', () => {
    // /stats/locations leaves users and deviceCount out while a single account
    // is selected, since the answer would just be the account already filtered on.
    render(<LocationPopupContent location={makeLocation({ count: 3 })} />);

    expect(screen.getByText(/3 streams/)).toBeInTheDocument();
    expect(screen.queryByText(/device/)).not.toBeInTheDocument();
  });

  it('falls back to Unknown when the country is missing', () => {
    render(<LocationPopupContent location={makeLocation({ city: null, country: null })} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('still renders the per-server breakdown', () => {
    render(
      <LocationPopupContent
        location={makeLocation({ users: [{ id: 'u1', username: 'conradir', thumbUrl: null }] })}
        serverBreakdown={[
          { serverId: 's1', count: 2 },
          { serverId: 's2', count: 1 },
        ]}
        serverNameMap={{ s1: 'Main', s2: 'Backup' }}
      />
    );

    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('Backup')).toBeInTheDocument();
    // The account list and the server list are separate blocks.
    expect(screen.getByText('conradir')).toBeInTheDocument();
  });
});
