import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { buildMediaServerItemUrl, formatMediaTech } from '@tracearr/shared';
import type { MediaAvailabilityEntry, MediaRequestEntry, ServerType } from '@tracearr/shared';
import type { MediaDetailData, MediaDetailStub } from '@/hooks/queries';
import { buildPosterSrc, POSTER_ASPECT_CLASS, type PosterAspect } from './PosterCard';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InlineErrorState } from '@/components/library/ErrorState';
import { RequestServiceIcon } from '@/components/icons/RequestServiceIcon';
import { Skeleton } from '@/components/ui/skeleton';
import { heroRequestLine, type Translate } from '@/components/requests/format';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/formatters';
import { formatDate } from '@/lib/dateFormat';

export interface HeroServerLookupEntry {
  name: string;
  type: ServerType;
  color?: string | null;
  /** Absent for members, whose server rows carry no internal address. */
  url?: string;
  publicUrl?: string | null;
  machineIdentifier?: string | null;
}

interface DetailHeroProps {
  data: MediaDetailData | undefined;
  stub: MediaDetailStub | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  serverById: Map<string, HeroServerLookupEntry>;
  onFullHistoryClick: () => void;
  request?: MediaRequestEntry | null;
}

function heroRequestText(request: MediaRequestEntry, t: Translate): string {
  const { identityName, username } = request.requester;
  const name = identityName ?? username ?? t('requests.unattributed');
  return heroRequestLine(request, name, t);
}

/** Two-letter glyph, mirroring PosterCard's fallback treatment at hero scale. */
function heroInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return '';
  if (!second) return (first[0] ?? '').toUpperCase() + (first[1] ?? '').toLowerCase();
  return (first[0] ?? '').toUpperCase() + (second[0] ?? '').toUpperCase();
}

/** Converts a `#rrggbb` dominant color to an unwrapped "H S% L%" triple for the `--cover` custom property. */
export function hexToHslTriple(hex: string): string | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) return null;
  const num = parseInt(match[1], 16);
  const r = ((num >> 16) & 0xff) / 255;
  const g = ((num >> 8) & 0xff) / 255;
  const b = (num & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

function joinMeta(parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => !!part).join(' · ');
}

function HeroPoster({
  title,
  posterUrl,
  posterVersion,
  dominantColor,
  aspect,
}: {
  title: string;
  posterUrl: string | null;
  posterVersion: string | null;
  dominantColor: string | null;
  aspect: PosterAspect;
}) {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [posterUrl]);

  const showFallback = !posterUrl || imgError;

  return (
    <div className="w-[150px] min-[761px]:w-[218px]">
      <div
        className={cn(
          'border-border/50 relative overflow-hidden rounded-xl border shadow-(--poster-hero)',
          POSTER_ASPECT_CLASS[aspect]
        )}
        style={dominantColor ? { backgroundColor: dominantColor } : undefined}
      >
        {showFallback ? (
          <div
            className="flex h-full w-full items-center justify-center p-3 text-center"
            style={{
              background: dominantColor
                ? `linear-gradient(160deg, ${dominantColor} 0%, oklch(var(--card-raised)) 100%)`
                : 'linear-gradient(160deg, oklch(var(--muted)) 0%, oklch(var(--card-raised)) 100%)',
            }}
          >
            <span
              aria-hidden="true"
              className={cn(
                'text-3xl leading-none font-bold',
                dominantColor
                  ? 'text-overlay-foreground/90 [text-shadow:0_2px_12px_hsl(var(--overlay)/0.4)]'
                  : 'text-foreground/85 dark:[text-shadow:0_2px_12px_hsl(var(--overlay)/0.4)]'
              )}
            >
              {heroInitials(title)}
            </span>
          </div>
        ) : (
          <img
            src={buildPosterSrc(posterUrl, posterVersion, { square: aspect === 'square' })}
            alt=""
            loading="eager"
            fetchPriority="high"
            decoding="async"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        )}
      </div>
    </div>
  );
}

function HeroBodySkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-64" />
      <div className="space-y-2">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3.5 w-52" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-32" />
      </div>
    </div>
  );
}

export interface OpenOnServerTarget {
  serverId: string;
  name: string;
  url: string;
}

/** One deep link per copy whose server is known, falling back to the server's own address. */
export function openOnServerTargets(
  copies: (Pick<MediaAvailabilityEntry, 'serverId' | 'ratingKey'> &
    Partial<Pick<MediaAvailabilityEntry, 'showRatingKey' | 'seasonNumber' | 'episodeNumber'>>)[],
  serverById: Map<string, HeroServerLookupEntry>,
  mediaType?: string
): OpenOnServerTarget[] {
  return copies.flatMap((entry) => {
    const server = serverById.get(entry.serverId);
    if (!server) return [];
    const base = server.publicUrl ?? server.url;
    const itemUrl = buildMediaServerItemUrl({
      serverType: server.type,
      baseUrl: base ?? '',
      ratingKey: entry.ratingKey,
      mediaType,
      showRatingKey: entry.showRatingKey,
      seasonNumber: entry.seasonNumber,
      episodeNumber: entry.episodeNumber,
      machineIdentifier: server.machineIdentifier,
    });
    const url = itemUrl ?? base;
    return url ? [{ serverId: entry.serverId, name: server.name, url }] : [];
  });
}

export function OpenOnServerAction({ targets }: { targets: OpenOnServerTarget[] }) {
  const { t } = useTranslation('pages');

  if (targets.length === 0) return null;

  if (targets.length === 1) {
    const target = targets[0];
    if (!target) return null;
    return (
      <Button variant="outline" asChild>
        <a href={target.url} target="_blank" rel="noreferrer">
          {t('media.detail.hero.actions.openOnServer')}
          <ExternalLink aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
        </a>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          {t('media.detail.hero.actions.openOnServer')}
          <ChevronDown aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {targets.map((target) => (
          <DropdownMenuItem key={target.serverId} asChild>
            <a href={target.url} target="_blank" rel="noreferrer">
              {target.name}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DetailHero({
  data,
  stub,
  isLoading,
  isError,
  onRetry,
  serverById,
  onFullHistoryClick,
  request,
}: DetailHeroProps) {
  const { t } = useTranslation(['pages', 'nav', 'common']);

  const title = data?.title ?? stub?.title;
  const year = data?.year ?? stub?.year ?? null;
  const mediaType = data?.mediaType;
  const availability = data?.availability;
  const removedEverywhere = !!availability && availability.every((a) => a.removedAt != null);
  const posterUrl = removedEverywhere ? null : (data?.posterUrl ?? stub?.posterUrl ?? null);
  const posterVersion = data?.posterVersion ?? stub?.posterVersion ?? null;
  const dominantColor = data?.dominantColor ?? stub?.dominantColor ?? null;
  const coverHsl = dominantColor ? hexToHslTriple(dominantColor) : null;

  const hasTitle = title != null;
  const hasCoreData = mediaType !== undefined;

  const segment =
    mediaType === 'movie'
      ? { label: t('media.movies.title'), href: '/media/browse' }
      : mediaType === 'show'
        ? { label: t('media.shows.title'), href: '/media/browse?type=show' }
        : mediaType === 'artist'
          ? { label: t('common:media.artist_plural'), href: '/media/browse?type=artist' }
          : null;

  const activeAvailability = (availability ?? []).filter((a) => a.removedAt == null);
  const editionTitles = new Set(
    activeAvailability.flatMap((a) => a.versions.map((v) => v.editionTitle ?? ''))
  );
  const [sharedEdition] = editionTitles.size === 1 ? editionTitles : [];

  const metaLine = joinMeta([
    year != null ? String(year) : null,
    sharedEdition,
    data?.seasonCount != null
      ? t('media.detail.hero.meta.seasons', { count: data.seasonCount })
      : null,
    data?.episodeCount != null
      ? t('media.detail.hero.meta.episodes', { count: data.episodeCount })
      : null,
    data?.genres && data.genres.length > 0 ? data.genres.join(', ') : null,
  ]);

  if (!hasTitle) {
    if (isError) {
      return (
        <div className="-mx-6 -mt-6 mb-0 border-b px-6 pt-7 pb-6">
          <InlineErrorState message={t('media.detail.hero.loadError')} onRetry={onRetry} />
        </div>
      );
    }
    if (!isLoading) return null;
    return (
      <div className="-mx-6 -mt-6 mb-0 border-b px-6 pt-7 pb-6">
        <div className="grid grid-cols-1 items-end gap-[26px] min-[761px]:grid-cols-[218px_1fr]">
          <div className="w-[150px] min-[761px]:w-[218px]">
            <Skeleton className="aspect-[2/3] w-full rounded-xl" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-8 w-72" />
            <HeroBodySkeleton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="-mx-6 -mt-6 mb-0 border-b px-6 pt-7 pb-6"
      style={
        {
          '--cover': coverHsl ? `hsl(${coverHsl})` : 'oklch(var(--muted))',
          background:
            'radial-gradient(900px 420px at 22% 0%, color-mix(in oklab, var(--cover) 35%, transparent), transparent 65%), linear-gradient(180deg, color-mix(in oklab, var(--cover) 16%, transparent), oklch(var(--background)) 88%)',
        } as CSSProperties
      }
    >
      <Breadcrumb aria-label={t('media.detail.breadcrumb.ariaLabel')} className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/library">{t('nav:library')}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {segment && (
            <>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to={segment.href}>{segment.label}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
            </>
          )}
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{title}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid grid-cols-1 items-end gap-[26px] min-[761px]:grid-cols-[218px_1fr]">
        <HeroPoster
          title={title}
          posterUrl={posterUrl}
          posterVersion={posterVersion}
          dominantColor={dominantColor}
          aspect={mediaType === 'artist' ? 'square' : 'poster'}
        />
        <div>
          <h1 className="text-3xl leading-tight font-bold tracking-[-0.025em] text-balance">
            {title}
          </h1>

          {!hasCoreData && isError ? (
            <InlineErrorState message={t('media.detail.hero.loadError')} onRetry={onRetry} />
          ) : !hasCoreData ? (
            <HeroBodySkeleton />
          ) : (
            <>
              {metaLine && <p className="text-muted-foreground text-dense mt-1">{metaLine}</p>}

              {availability && (availability.length > 0 || removedEverywhere) && (
                <div className="mt-3.5 flex flex-col gap-1.5">
                  {availability.map((entry) => {
                    const server = serverById.get(entry.serverId);
                    const removed = entry.removedAt != null;
                    const dateText = removed
                      ? t('media.detail.hero.availability.addedRemoved', {
                          added: formatDate(new Date(entry.addedAt), { dateStyle: 'medium' }),
                          removed: formatDate(new Date(entry.removedAt as string), {
                            dateStyle: 'medium',
                          }),
                        })
                      : t('media.detail.hero.availability.added', {
                          date: formatDate(new Date(entry.addedAt), { dateStyle: 'medium' }),
                        });
                    // A witnessed replacement tells the swap as one line, dated by
                    // the removal event rather than the server's claimed added date
                    const caption =
                      entry.replaces && !removed
                        ? joinMeta([
                            t('media.detail.hero.availability.added', {
                              date: formatDate(new Date(entry.replaces.addedAt), {
                                dateStyle: 'medium',
                              }),
                            }),
                            entry.replaces.videoResolution
                              ? formatMediaTech(entry.replaces.videoResolution)
                              : null,
                            entry.replaces.fileSize != null
                              ? formatBytes(entry.replaces.fileSize, 1, { minUnit: 'GB' })
                              : null,
                            t('media.detail.hero.availability.replaced', {
                              date: formatDate(new Date(entry.replaces.removedAt), {
                                dateStyle: 'medium',
                              }),
                            }),
                            entry.videoResolution ? formatMediaTech(entry.videoResolution) : null,
                            entry.fileSize != null
                              ? formatBytes(entry.fileSize, 1, { minUnit: 'GB' })
                              : null,
                          ])
                        : joinMeta([
                            dateText,
                            entry.videoResolution ? formatMediaTech(entry.videoResolution) : null,
                            entry.fileSize != null
                              ? formatBytes(entry.fileSize, 1, { minUnit: 'GB' })
                              : null,
                          ]);
                    return (
                      <div
                        key={`${entry.serverId}-${entry.ratingKey}`}
                        className={cn(
                          'text-dense flex flex-wrap items-center gap-2.5',
                          removed && 'opacity-55'
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className="bg-muted-foreground h-1.5 w-1.5 shrink-0 rounded-full"
                          style={server?.color ? { backgroundColor: server.color } : undefined}
                        />
                        <strong className="font-semibold">{server?.name ?? entry.serverId}</strong>
                        <span
                          className={cn(
                            'text-muted-foreground tabular-nums',
                            removed && 'line-through'
                          )}
                        >
                          {caption}
                        </span>
                      </div>
                    );
                  })}
                  {removedEverywhere && (
                    <p className="text-muted-foreground text-dense mt-1 italic">
                      {t('media.detail.hero.removedEverywhere.caption')}
                    </p>
                  )}
                </div>
              )}

              {request && (
                <p className="text-muted-foreground text-dense mt-2 flex items-center gap-2">
                  <RequestServiceIcon type={request.serviceType} className="h-3.5 w-3.5" />
                  <span>{heroRequestText(request, t as Translate)}</span>
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={onFullHistoryClick}>
                  {t('media.detail.hero.actions.fullHistory')}
                </Button>
                {!removedEverywhere && (
                  <OpenOnServerAction
                    targets={openOnServerTargets(activeAvailability, serverById, mediaType)}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
