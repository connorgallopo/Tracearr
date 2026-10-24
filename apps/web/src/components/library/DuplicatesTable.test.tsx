import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatMediaTech, type DuplicateItem, type DuplicatesResponse } from '@tracearr/shared';
import { DuplicatesTable } from './DuplicatesTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

const useDuplicateFiles = vi.fn();
vi.mock('@/hooks/queries/useLibrary', () => ({
  useDuplicateFiles: (itemIds: string[], enabled: boolean) => useDuplicateFiles(itemIds, enabled),
}));

const ITEM_ID = '11111111-1111-4111-8111-111111111111';

function response(itemOverrides: Partial<DuplicateItem> = {}): DuplicatesResponse {
  return {
    duplicates: [
      {
        matchKey: 'imdb:movie:tt0000001',
        matchType: 'imdb',
        confidence: 100,
        serverCount: 1,
        sameServer: true,
        uniqueFileCount: 2,
        totalStorageBytes: 17_000_000_000,
        potentialSavingsBytes: 4_000_000_000,
        items: [
          {
            id: ITEM_ID,
            serverId: 'srv-1',
            serverName: 'Plex',
            libraryId: '1',
            libraryName: 'Movies',
            title: 'Blade Runner 2049',
            year: 2017,
            mediaType: 'movie',
            grandparentTitle: null,
            parentTitle: null,
            seasonNumber: null,
            episodeNumber: null,
            fileSize: 17_000_000_000,
            resolution: '4k',
            versions: [
              {
                serverVersionKey: '42858',
                resolution: '4k',
                videoCodec: 'HEVC',
                audioCodec: 'EAC3',
                fileSize: 13_000_000_000,
                filePath: '/data/movies/Blade Runner 2049 (2017)/BR2049.2160p.mkv',
              },
              {
                serverVersionKey: '42859',
                resolution: '1080p',
                videoCodec: 'H264',
                audioCodec: 'AAC',
                fileSize: 4_000_000_000,
                filePath: '/data/movies/Blade Runner 2049 (2017)/BR2049.1080p.mkv',
              },
            ],
            ...itemOverrides,
          },
        ],
      },
    ],
    summary: {
      totalGroups: 1,
      totalDuplicateItems: 1,
      totalPotentialSavingsBytes: 4_000_000_000,
      byMatchType: { imdb: 1, tmdb: 0, tvdb: 0, mbid: 0, fuzzy: 0, version: 0 },
    },
    pagination: { page: 1, pageSize: 20, total: 1 },
  };
}

function renderTable(itemOverrides: Partial<DuplicateItem> = {}) {
  return render(
    <DuplicatesTable
      data={response(itemOverrides)}
      onRetry={vi.fn()}
      page={1}
      onPageChange={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useDuplicateFiles.mockReturnValue({ data: undefined });
});

describe('DuplicatesTable', () => {
  it('shows each file by name and only checks a group once it is expanded', async () => {
    renderTable();

    expect(useDuplicateFiles).not.toHaveBeenCalled();
    expect(screen.queryByText('BR2049.2160p.mkv')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Blade Runner 2049'));

    expect(useDuplicateFiles).toHaveBeenLastCalledWith([ITEM_ID], true);
    expect(screen.getByText('BR2049.2160p.mkv')).toBeInTheDocument();
    expect(screen.getByText('BR2049.1080p.mkv')).toBeInTheDocument();
  });

  it('flags only the version the server reported as gone', async () => {
    useDuplicateFiles.mockReturnValue({
      data: {
        checked: true,
        files: [
          { itemId: ITEM_ID, serverVersionKey: '42858', exists: true },
          { itemId: ITEM_ID, serverVersionKey: '42859', exists: false },
        ],
      },
    });
    renderTable();

    await userEvent.click(screen.getByText('Blade Runner 2049'));

    const missing = screen.getByText('library.storage.missingOnServer');
    expect(missing).toBeInTheDocument();
    expect(missing.closest('div')?.textContent).toContain('BR2049.1080p.mkv');
  });

  it('heads a movie group with its title, year and Movie badge', () => {
    renderTable();

    expect(screen.getByText('Blade Runner 2049')).toBeInTheDocument();
    expect(screen.getByText('(2017)')).toBeInTheDocument();
    expect(screen.getByText('media.movie')).toBeInTheDocument();
  });

  it('heads an episode group with the series title over the episode', () => {
    renderTable({
      title: 'Grilled',
      mediaType: 'episode',
      grandparentTitle: 'Breaking Bad',
      seasonNumber: 2,
      episodeNumber: 2,
      year: null,
    });

    expect(screen.getByText('Breaking Bad')).toBeInTheDocument();
    expect(screen.getByText('S02 E02 · Grilled')).toBeInTheDocument();
    expect(screen.getByText('media.tv')).toBeInTheDocument();
  });

  it('labels each copy in an episode group with its own season and episode', async () => {
    renderTable({
      title: 'Grilled',
      mediaType: 'episode',
      grandparentTitle: 'Breaking Bad',
      seasonNumber: 2,
      episodeNumber: 2,
      year: null,
    });

    await userEvent.click(screen.getByText('Breaking Bad'));

    expect(screen.getByText('S02 E02')).toBeInTheDocument();
  });

  it('heads a music group with the artist and album under the track', () => {
    renderTable({
      title: 'Redbone',
      mediaType: 'track',
      grandparentTitle: 'Childish Gambino',
      parentTitle: 'Awaken, My Love!',
      year: null,
    });

    expect(screen.getByText('Redbone')).toBeInTheDocument();
    expect(screen.getByText('Childish Gambino · Awaken, My Love!')).toBeInTheDocument();
    expect(screen.getByText('media.music')).toBeInTheDocument();
  });

  it('tells copies of a track apart by audio codec', async () => {
    renderTable({
      title: 'Redbone',
      mediaType: 'track',
      grandparentTitle: 'Childish Gambino',
      resolution: null,
      versions: [
        {
          serverVersionKey: '1',
          resolution: null,
          videoCodec: null,
          audioCodec: 'flac',
          fileSize: 38_000_000,
          filePath: '/music/Redbone.flac',
        },
      ],
    });

    await userEvent.click(screen.getByText('Redbone'));

    expect(screen.getByText(formatMediaTech('flac'))).toBeInTheDocument();
  });
});
