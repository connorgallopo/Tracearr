import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';

const markerEls: HTMLElement[] = [];
const popupInstances: Array<{ container?: HTMLElement }> = [];

vi.mock('maplibre-gl', () => {
  class FakeMap {
    handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    on(ev: string, fn: (...a: unknown[]) => void) {
      (this.handlers[ev] ??= []).push(fn);
      return this;
    }
    off() {
      return this;
    }
    once() {
      return this;
    }
    addControl() {
      return this;
    }
    setStyle() {
      return this;
    }
    remove() {
      return this;
    }
    fitBounds() {
      return this;
    }
    getCanvas() {
      return { style: {} };
    }
  }
  class FakeMarker {
    el: HTMLElement;
    constructor(opts: { element: HTMLElement }) {
      this.el = opts.element;
      markerEls.push(this.el);
    }
    setLngLat() {
      return this;
    }
    addTo() {
      document.body.appendChild(this.el);
      return this;
    }
    remove() {
      this.el.remove();
    }
  }
  class FakePopup {
    container?: HTMLElement;
    constructor() {
      popupInstances.push(this);
    }
    setLngLat() {
      return this;
    }
    setDOMContent(c: HTMLElement) {
      this.container = c;
      document.body.appendChild(c);
      return this;
    }
    addTo() {
      return this;
    }
    closeHandlers: (() => void)[] = [];
    on(ev: string, fn: () => void) {
      if (ev === 'close') this.closeHandlers.push(fn);
      return this;
    }
    off(ev: string, fn: () => void) {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== fn);
      return this;
    }
    // Real maplibre fires 'close' from remove(); the first fake missed that
    // and hid a popup closing itself during StrictMode effect teardown.
    remove() {
      this.container?.remove();
      this.closeHandlers.forEach((h) => h());
    }
  }
  return {
    Map: FakeMap,
    Marker: FakeMarker,
    Popup: FakePopup,
    AttributionControl: class {
      onAdd = vi.fn();
    },
    NavigationControl: class {
      onAdd = vi.fn();
    },
    addProtocol: vi.fn(),
    setWorkerUrl: vi.fn(),
  };
});
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: 'worker.js' }));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('pmtiles', () => ({
  PMTiles: class {
    getHeader() {
      return Promise.resolve({});
    }
  },
  Protocol: class {
    tile = vi.fn();
    add = vi.fn();
  },
}));
vi.mock('@protomaps/basemaps', () => ({ layers: () => [], namedFlavor: () => ({}) }));
const auth = vi.hoisted(() => ({ user: { role: 'owner' } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'dark', accentHue: 187 }),
  accentPreset: () => ({ okHue: 212 }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

import { DEFAULT_STREAM_DETAILS, type ActiveSession, type NonMainProfile } from '@tracearr/shared';
import { StreamCard } from '@/components/map/StreamCard';

const KIDS: NonMainProfile = { name: 'Kids', thumbUrl: null, removed: false };

const playing: ActiveSession = {
  ...DEFAULT_STREAM_DETAILS,
  id: 's1',
  serverId: 'srv1',
  serverUserId: 'su1',
  sessionKey: 'k1',
  state: 'playing',
  mediaType: 'movie',
  mediaTitle: 'Blade Runner',
  grandparentTitle: null,
  seasonNumber: null,
  episodeNumber: null,
  year: 2017,
  thumbPath: null,
  ratingKey: null,
  serverVersionKey: null,
  parentRatingKey: null,
  grandparentRatingKey: null,
  mediaId: null,
  showMediaId: null,
  imdbId: null,
  tmdbId: null,
  tvdbId: null,
  externalSessionId: null,
  startedAt: new Date('2026-11-24T12:00:00.000Z'),
  stoppedAt: null,
  durationMs: null,
  totalDurationMs: null,
  progressMs: null,
  lastPausedAt: null,
  pausedDurationMs: 0,
  referenceId: null,
  watched: false,
  ipAddress: '203.0.113.7',
  geoCity: 'Philadelphia',
  geoRegion: 'PA',
  geoCountry: 'US',
  geoContinent: null,
  geoPostal: null,
  geoLat: 40.0,
  geoLon: -75.0,
  geoAsnNumber: null,
  geoAsnOrganization: null,
  isLocal: false,
  profileId: null,
  profileName: null,
  playerName: null,
  deviceId: null,
  product: 'Plex Web',
  device: null,
  platform: 'Chrome',
  quality: null,
  isTranscode: false,
  videoDecision: null,
  audioDecision: null,
  bitrate: null,
  channelTitle: null,
  channelIdentifier: null,
  channelThumb: null,
  artistName: null,
  albumName: null,
  trackNumber: null,
  discNumber: null,
  user: { id: 'u1', username: 'gallapagos', identityName: null, thumbUrl: null },
  server: { id: 'srv1', name: 'Plex', type: 'plex' },
  canTerminate: true,
};

describe('StreamCard marker popup wiring', () => {
  it('opens the session popup when the dot is clicked', async () => {
    render(
      <StrictMode>
        <MemoryRouter>
          <StreamCard sessions={[playing]} />
        </MemoryRouter>
      </StrictMode>
    );
    await waitFor(() => expect(markerEls.length).toBeGreaterThan(0));
    fireEvent.click(markerEls[0]!);
    await waitFor(() => expect(screen.getByText('Blade Runner')).toBeInTheDocument());
    const connected = new Set(popupInstances.map((i) => i.container).filter((c) => c?.isConnected));
    expect(connected.size).toBe(1);
  });
});

describe('StreamCard session popup', () => {
  it('links the person to their user page for an owner only', async () => {
    const { unmount } = render(
      <MemoryRouter>
        <StreamCard sessions={[playing]} />
      </MemoryRouter>
    );
    await waitFor(() => expect(markerEls.some((el) => el.isConnected)).toBe(true));
    let connected = markerEls.filter((el) => el.isConnected);
    fireEvent.click(connected[connected.length - 1]!);
    expect(await screen.findByRole('link', { name: /gallapagos/ })).toHaveAttribute(
      'href',
      '/users/u1'
    );
    unmount();

    auth.user.role = 'member';
    render(
      <MemoryRouter>
        <StreamCard sessions={[playing]} />
      </MemoryRouter>
    );
    await waitFor(() => expect(markerEls.some((el) => el.isConnected)).toBe(true));
    connected = markerEls.filter((el) => el.isConnected);
    fireEvent.click(connected[connected.length - 1]!);
    expect(await screen.findByText('gallapagos')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /gallapagos/ })).toBeNull();
    auth.user.role = 'owner';
  });

  it('links the show and the episode to their media pages', async () => {
    const episode: ActiveSession = {
      ...playing,
      id: 's2',
      mediaType: 'episode',
      mediaTitle: 'Pilot',
      grandparentTitle: 'Lost',
      seasonNumber: 1,
      episodeNumber: 2,
      mediaId: 'episode-1',
      showMediaId: 'show-1',
    };
    render(
      <MemoryRouter>
        <StreamCard sessions={[episode]} />
      </MemoryRouter>
    );
    await waitFor(() => expect(markerEls.some((el) => el.isConnected)).toBe(true));
    const connected = markerEls.filter((el) => el.isConnected);
    fireEvent.click(connected[connected.length - 1]!);

    expect(await screen.findByRole('link', { name: 'Lost' })).toHaveAttribute(
      'href',
      '/media/show-1'
    );
    expect(screen.getByRole('link', { name: /Pilot/ })).toHaveAttribute('href', '/media/episode-1');
  });

  it('badges the person with a non-main profile in the session popup', async () => {
    const openPopup = async (shown: ActiveSession) => {
      const view = render(
        <MemoryRouter>
          <StreamCard sessions={[shown]} />
        </MemoryRouter>
      );
      await waitFor(() => expect(markerEls.some((el) => el.isConnected)).toBe(true));
      const connected = markerEls.filter((el) => el.isConnected);
      const marker = connected[connected.length - 1];
      if (!marker) throw new Error('the stream has no marker');
      fireEvent.click(marker);
      await screen.findByText('gallapagos');
      return view;
    };

    const { unmount } = await openPopup({ ...playing, nonMainProfile: KIDS });
    expect(screen.getByRole('img', { name: 'Kids' })).toBeInTheDocument();
    unmount();

    await openPopup(playing);
    expect(screen.queryByRole('img', { name: 'Kids' })).toBeNull();
  });
});
