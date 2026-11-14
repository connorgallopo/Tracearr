import { useTranslation } from 'react-i18next';
import { SQUARE_POSTER_SIZE, type MediaChildEntry } from '@tracearr/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineErrorState } from '@/components/library/ErrorState';
import { imageProxyUrl } from '@/lib/basePath';
import { PosterArt } from './PosterCard';

interface AlbumsPanelProps {
  albums: MediaChildEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onSelect: (albumId: string) => void;
}

const GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-3.5 gap-y-4';

function AlbumsSkeleton() {
  return (
    <div className={GRID_CLASS}>
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="space-y-1.5">
          <Skeleton className="aspect-square w-full rounded-md" />
          <Skeleton className="h-3.5 w-full" />
        </div>
      ))}
    </div>
  );
}

/** An artist's albums, one entry per server copy, in place of a show's seasons. */
export function AlbumsPanel({ albums, isLoading, isError, onRetry, onSelect }: AlbumsPanelProps) {
  const { t } = useTranslation(['pages', 'common']);

  return (
    <section
      aria-labelledby="albums-panel-heading"
      className="bg-card rounded-xl border p-6 shadow-sm"
    >
      <h2 id="albums-panel-heading" className="mb-3 text-base font-semibold">
        {t('media.detail.albums.title')}
      </h2>

      {isError ? (
        <InlineErrorState message={t('media.detail.albums.loadError')} onRetry={onRetry} />
      ) : isLoading || albums === undefined ? (
        <AlbumsSkeleton />
      ) : albums.length === 0 ? (
        <EmptyState title={t('common:empty.noData')} className="py-6" />
      ) : (
        <ul className={GRID_CLASS}>
          {albums.map((album) => (
            <li key={`${album.id}:${album.serverId ?? ''}`} className="min-w-0">
              <button
                type="button"
                onClick={() => onSelect(album.id)}
                className="group focus-visible:ring-ring w-full min-w-0 cursor-pointer space-y-1.5 rounded-md text-left focus-visible:ring-2 focus-visible:outline-none"
              >
                <span className="bg-muted block aspect-square overflow-hidden rounded-xl transition-transform duration-200 group-hover:-translate-y-[3px] group-hover:shadow-(--poster-lift)">
                  <PosterArt
                    src={
                      album.thumbPath && album.serverId
                        ? imageProxyUrl(
                            album.serverId,
                            album.thumbPath,
                            SQUARE_POSTER_SIZE.width,
                            SQUARE_POSTER_SIZE.height
                          )
                        : null
                    }
                    title={album.title}
                    dominantColor={null}
                    loading="lazy"
                  />
                </span>
                <span className="block truncate text-sm font-medium">{album.title}</span>
                <span className="text-muted-foreground block truncate text-xs tabular-nums">
                  {[
                    album.year != null ? String(album.year) : null,
                    album.trackCount != null
                      ? t('media.detail.albums.trackCount', { count: album.trackCount })
                      : null,
                  ]
                    .filter((part): part is string => part != null)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
