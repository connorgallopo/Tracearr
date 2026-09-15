import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImageCacheStatus } from '@tracearr/shared';
import { ImageCacheCard } from './ImageCacheCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useImageCacheStatus: vi.fn(),
}));

import { useImageCacheStatus } from '@/hooks/queries';

const mockUseImageCacheStatus = vi.mocked(useImageCacheStatus);

function status(overrides: Partial<ImageCacheStatus> = {}): ImageCacheStatus {
  return {
    bytes: 12345,
    files: 10,
    versionedFiles: 8,
    sweptAt: '2026-08-20T00:00:00.000Z',
    freedBytesLastSweep: 500,
    deletedFilesLastSweep: 2,
    postersWithThumb: 42,
    estimatedNeedBytes: 42 * 18 * 1024,
    freeBytes: 50 * 1024 ** 3,
    totalBytes: 100 * 1024 ** 3,
    minFreePercent: 10,
    maxBytes: null,
    diskLimitedSince: null,
    shortfallBytes: 0,
    ...overrides,
  };
}

describe('ImageCacheCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a skeleton while loading', () => {
    mockUseImageCacheStatus.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useImageCacheStatus>);

    const { container } = render(<ImageCacheCard />);

    expect(container.querySelector('dl')).not.toBeInTheDocument();
  });

  it('shows a plain error line when the query failed', () => {
    mockUseImageCacheStatus.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useImageCacheStatus>);

    const { container } = render(<ImageCacheCard />);

    expect(screen.getByText('general.imageCache.loadError')).toBeInTheDocument();
    expect(container.querySelector('dl')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeInTheDocument();
  });

  it('renders the numbers from the mocked query', () => {
    mockUseImageCacheStatus.mockReturnValue({
      data: status(),
      isLoading: false,
    } as unknown as ReturnType<typeof useImageCacheStatus>);

    render(<ImageCacheCard />);

    expect(screen.getByText('12.1 KB')).toBeInTheDocument(); // bytes
    expect(screen.getByText('10')).toBeInTheDocument(); // files
    expect(screen.getByText('10%')).toBeInTheDocument(); // minFreePercent
    expect(
      screen.getByText('general.imageCache.needHint:{"count":42}', { exact: false })
    ).toBeInTheDocument();
    expect(
      screen.getByText('general.imageCache.freeOf:{"total":"100 GB"}', { exact: false })
    ).toBeInTheDocument();
  });

  it('hides the ceiling row when maxBytes is null', () => {
    mockUseImageCacheStatus.mockReturnValue({
      data: status({ maxBytes: null }),
      isLoading: false,
    } as unknown as ReturnType<typeof useImageCacheStatus>);

    render(<ImageCacheCard />);

    expect(screen.queryByText('general.imageCache.ceiling')).not.toBeInTheDocument();
  });

  it('shows the ceiling row when maxBytes is set', () => {
    mockUseImageCacheStatus.mockReturnValue({
      data: status({ maxBytes: 5 * 1024 ** 3 }),
      isLoading: false,
    } as unknown as ReturnType<typeof useImageCacheStatus>);

    render(<ImageCacheCard />);

    expect(screen.getByText('general.imageCache.ceiling')).toBeInTheDocument();
    expect(screen.getByText('5 GB')).toBeInTheDocument();
  });

  it('shows "never" when the cache has not swept yet', () => {
    mockUseImageCacheStatus.mockReturnValue({
      data: status({ sweptAt: null }),
      isLoading: false,
    } as unknown as ReturnType<typeof useImageCacheStatus>);

    render(<ImageCacheCard />);

    expect(screen.getByText('general.imageCache.never')).toBeInTheDocument();
  });

  it('shows the disk-limited line when diskLimitedSince is set', () => {
    mockUseImageCacheStatus.mockReturnValue({
      data: status({
        diskLimitedSince: '2026-08-01T00:00:00.000Z',
        shortfallBytes: 1024 ** 3,
      }),
      isLoading: false,
    } as unknown as ReturnType<typeof useImageCacheStatus>);

    render(<ImageCacheCard />);

    expect(
      screen.getByText('general.imageCache.diskLimited', { exact: false })
    ).toBeInTheDocument();
    expect(screen.getByText('"shortfall":"1 GB"', { exact: false })).toBeInTheDocument();
  });

  it('hides the disk-limited line when diskLimitedSince is null', () => {
    mockUseImageCacheStatus.mockReturnValue({
      data: status({ diskLimitedSince: null }),
      isLoading: false,
    } as unknown as ReturnType<typeof useImageCacheStatus>);

    render(<ImageCacheCard />);

    expect(screen.queryByText('general.imageCache.diskLimited', { exact: false })).toBeNull();
  });
});
