import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';
import { PlexClient } from '../client.js';

vi.mock('../../../../utils/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpModule>()),
  fetchJson: vi.fn(),
  plexHeaders: vi.fn().mockReturnValue({ 'X-Plex-Token': 'test-token' }),
}));

import { fetchJson } from '../../../../utils/http.js';

const mockFetchJson = vi.mocked(fetchJson);

function plexSession(opts: { sessionKey: string; ratingKey: string; transcoding: boolean }) {
  return {
    sessionKey: opts.sessionKey,
    ratingKey: opts.ratingKey,
    type: 'movie',
    title: `Movie ${opts.ratingKey}`,
    User: { id: '1', title: 'User1' },
    Player: { title: 'TV', machineIdentifier: `dev-${opts.sessionKey}`, state: 'playing' },
    ...(opts.transcoding && {
      TranscodeSession: { videoDecision: 'transcode', audioDecision: 'copy' },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PlexClient.getSessions with a session key', () => {
  it('fetches metadata only for the requested session', async () => {
    mockFetchJson.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          plexSession({ sessionKey: '7', ratingKey: '70', transcoding: true }),
          plexSession({ sessionKey: '8', ratingKey: '80', transcoding: false }),
        ],
      },
    });
    const client = new PlexClient({ url: 'http://plex.local:32400', token: 'test-token' });

    const sessions = await client.getSessions('8');

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(sessions.map((s) => s.sessionKey)).toEqual(['8']);
  });
});

describe('PlexClient.getSessions with a live session that names no channel', () => {
  const liveSession = {
    sessionKey: '7',
    ratingKey: '10123913',
    guid: 'plex://episode/5d9c0874ffd9ef001e99607a',
    type: 'episode',
    live: '1',
    title: 'Episode 14',
    grandparentTitle: 'Friends',
    User: { id: '1', title: 'User1' },
    Player: { title: 'TV', machineIdentifier: 'dev-7', state: 'playing' },
    Media: [{ channelCallSign: 'KXAS', channelIdentifier: '2319' }],
  };

  it('takes the channel from the first guide that lists the program', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [liveSession] } })
      .mockResolvedValueOnce({
        MediaContainer: { Dvr: [{ epgIdentifier: 'guide:1' }, { epgIdentifier: 'guide:2' }] },
      })
      .mockResolvedValueOnce({ MediaContainer: { size: 0 } })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            {
              thumb: 'http://plex.tmsimg.com/assets/p183931_b_v8_ac.jpg',
              Media: [{ channelTitle: 'NBC 5', channelCallSign: 'KXAS' }],
            },
          ],
        },
      });
    const client = new PlexClient({ url: 'http://plex.local:32400', token: 'test-token' });

    const [session] = await client.getSessions();

    expect(mockFetchJson.mock.calls.map(([url]) => url)).toEqual([
      'http://plex.local:32400/status/sessions',
      'http://plex.local:32400/livetv/dvrs',
      'http://plex.local:32400/guide:1/metadata/plex%3A%2F%2Fepisode%2F5d9c0874ffd9ef001e99607a',
      'http://plex.local:32400/guide:2/metadata/plex%3A%2F%2Fepisode%2F5d9c0874ffd9ef001e99607a',
    ]);
    expect(session?.live).toMatchObject({ channelTitle: 'NBC 5', channelIdentifier: '2319' });
    expect(session?.media.thumbPath).toBe('http://plex.tmsimg.com/assets/p183931_b_v8_ac.jpg');
  });

  it('reads the guide once for a program that stays on', async () => {
    mockFetchJson.mockImplementation(async (url) => {
      if (url.endsWith('/status/sessions')) return { MediaContainer: { Metadata: [liveSession] } };
      if (url.endsWith('/livetv/dvrs')) {
        return { MediaContainer: { Dvr: [{ epgIdentifier: 'guide:1' }] } };
      }
      return { MediaContainer: { Metadata: [{ Media: [{ channelTitle: 'NBC 5' }] }] } };
    });
    const poll = () =>
      new PlexClient({ url: 'http://plex-steady.local:32400', token: 'test-token' }).getSessions();

    await poll();
    await poll();

    expect(mockFetchJson.mock.calls.map(([url]) => url)).toEqual([
      'http://plex-steady.local:32400/status/sessions',
      'http://plex-steady.local:32400/livetv/dvrs',
      'http://plex-steady.local:32400/guide:1/metadata/plex%3A%2F%2Fepisode%2F5d9c0874ffd9ef001e99607a',
      'http://plex-steady.local:32400/status/sessions',
    ]);
  });

  it('asks the guide again on the next read when it did not answer', async () => {
    const guideRead = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ MediaContainer: { Metadata: [{ Media: [{ channelTitle: 'NBC 5' }] }] } });
    mockFetchJson.mockImplementation(async (url) => {
      if (url.endsWith('/status/sessions')) return { MediaContainer: { Metadata: [liveSession] } };
      if (url.endsWith('/livetv/dvrs')) {
        return { MediaContainer: { Dvr: [{ epgIdentifier: 'guide:1' }] } };
      }
      return guideRead();
    });
    const poll = () =>
      new PlexClient({ url: 'http://plex-flaky.local:32400', token: 'test-token' }).getSessions();

    const [first] = await poll();
    const [second] = await poll();

    expect(first?.live?.channelTitle).toBe('KXAS');
    expect(second?.live?.channelTitle).toBe('NBC 5');
  });

  it('leaves the session as it is when the server has no guide', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [liveSession] } })
      .mockRejectedValueOnce(new Error('404'));
    const client = new PlexClient({ url: 'http://plex-no-guide.local:32400', token: 'test-token' });

    const [session] = await client.getSessions();

    expect(session?.media.type).toBe('live');
    expect(session?.live?.channelTitle).toBe('KXAS');
  });
});
