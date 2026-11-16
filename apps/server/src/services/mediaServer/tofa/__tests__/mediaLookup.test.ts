import { describe, it, expect, vi } from 'vitest';
import tofa from '../../../../test/mediaServerResponses/tofa.json' with { type: 'json' };
import { lookupTofaMedia } from '../mediaLookup.js';

const [movie, show] = tofa.mediaBatch;
if (!movie || !show) throw new Error('the recording holds a movie and a show');
const playedFile = show.files[0]?.id ?? '';

function source(url: string) {
  return { url, getMediaBatch: vi.fn() };
}

describe('lookupTofaMedia', () => {
  it('leaves out media whose lookup failed and fills it in on the next call', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = source('http://failing.local');
    const wanted = [{ mediaId: movie.id, fileId: movie.files[0]?.id ?? '' }];

    client.getMediaBatch.mockRejectedValueOnce(new Error('timeout'));
    expect((await lookupTofaMedia(client, wanted)).size).toBe(0);

    client.getMediaBatch.mockResolvedValueOnce([movie]);
    expect((await lookupTofaMedia(client, wanted)).get(movie.id)).toMatchObject({
      kind: 'movie',
      title: 'The Paper Kite',
    });
  });

  it('reads cached media again only when a show gains a file it did not list', async () => {
    const client = source('http://cached.local');
    client.getMediaBatch.mockResolvedValue([show]);

    await lookupTofaMedia(client, [{ mediaId: show.id, fileId: playedFile }]);
    await lookupTofaMedia(client, [{ mediaId: show.id, fileId: playedFile }]);
    expect(client.getMediaBatch).toHaveBeenCalledTimes(1);

    await lookupTofaMedia(client, [{ mediaId: show.id, fileId: 'file-added-since' }]);
    expect(client.getMediaBatch).toHaveBeenCalledTimes(2);
  });

  it('does not ask again for a file the last read did not describe', async () => {
    const client = source('http://misses.local');
    client.getMediaBatch.mockResolvedValue([show]);
    const unlisted = [
      { mediaId: show.id, fileId: 'file-without-episode' },
      { mediaId: 'media-not-returned', fileId: 'file-1' },
    ];

    await lookupTofaMedia(client, unlisted);
    await lookupTofaMedia(client, unlisted);

    expect(client.getMediaBatch).toHaveBeenCalledTimes(1);
  });

  it('asks for at most 50 media in one call', async () => {
    const client = source('http://large.local');
    client.getMediaBatch.mockResolvedValue([]);

    await lookupTofaMedia(
      client,
      Array.from({ length: 120 }, (_, i) => ({ mediaId: `media-${i}`, fileId: `file-${i}` }))
    );

    expect(client.getMediaBatch.mock.calls.map(([ids]) => ids.length)).toEqual([50, 50, 20]);
  });
});
