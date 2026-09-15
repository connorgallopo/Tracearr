import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { format } from 'date-fns';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { buildMediaServerItemUrl } from '@tracearr/shared';
import type { MediaAvailabilityEntry, MediaRequestEntry, ServerType } from '@tracearr/shared';
import type { MediaDetailData, MediaDetailStub } from '@/hooks/queries';
import { buildPosterSrc } from './PosterCard';
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
import { Skeleton } from '@/components/ui/skeleton';
import { heroRequestLine, type Translate } from '@/components/requests/format';
import { BASE_URL } from '@/lib/basePath';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/formatters';

export interface HeroServerLookupEntry {
  name: string;
  type: ServerType;
  color?: string | null;
  url: string;
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
  return heroRequestLine(request, name, t, 'MMM d, yyyy');
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
}: {
  title: string;
  posterUrl: string | null;
  posterVersion: string | null;
  dominantColor: string | null;
}) {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [posterUrl]);

  const showFallback = !posterUrl || imgError;

  return (
    <div className="w-[150px] min-[761px]:w-[218px]">
      <div
        className="border-border/50 relative aspect-[2/3] overflow-hidden rounded-[calc(var(--radius)+4px)] border shadow-[0_24px_60px_hsl(240_10%_2%/0.6)]"
        style={dominantColor ? { backgroundColor: dominantColor } : undefined}
      >
        {showFallback ? (
          <div
            className="flex h-full w-full items-center justify-center p-3 text-center"
            style={{
              background: dominantColor
                ? `linear-gradient(160deg, ${dominantColor} 0%, hsl(var(--card-raised)) 100%)`
                : 'linear-gradient(160deg, hsl(var(--muted)) 0%, hsl(var(--card-raised)) 100%)',
            }}
          >
            <span
              aria-hidden="true"
              className="text-[30px] leading-none font-bold text-white/90 [text-shadow:0_2px_12px_hsl(240_10%_2%/0.4)]"
            >
              {heroInitials(title)}
            </span>
          </div>
        ) : (
          <img
            src={buildPosterSrc(posterUrl, posterVersion)}
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

function OpenOnServerAction({
  activeAvailability,
  serverById,
}: {
  activeAvailability: MediaAvailabilityEntry[];
  serverById: Map<string, HeroServerLookupEntry>;
}) {
  const { t } = useTranslation('pages');

  const targets = activeAvailability
    .map((entry) => {
      const server = serverById.get(entry.serverId);
      if (!server) return null;
      const itemUrl = buildMediaServerItemUrl({
        serverType: server.type,
        baseUrl: server.url,
        ratingKey: entry.ratingKey,
        machineIdentifier: server.machineIdentifier,
      });
      return { serverId: entry.serverId, name: server.name, url: itemUrl ?? server.url };
    })
    .filter((target): target is { serverId: string; name: string; url: string } => !!target);

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
  const { t } = useTranslation('pages');

  const title = data?.title ?? stub?.title;
  const year = data?.year ?? stub?.year ?? null;
  const mediaType = data?.mediaType;
  const availability = data?.availability;
  const removedEverywhere =
    !!availability && availability.length > 0 && availability.every((a) => a.removedAt != null);
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
        ? { label: t('media.shows.title'), href: '/media/browse?type=shows' }
        : null;

  const metaLine = joinMeta([
    year != null ? String(year) : null,
    data?.seasonCount != null
      ? t('media.detail.hero.meta.seasons', { count: data.seasonCount })
      : null,
    data?.episodeCount != null
      ? t('media.detail.hero.meta.episodes', { count: data.episodeCount })
      : null,
    data?.genres && data.genres.length > 0 ? data.genres.join(', ') : null,
  ]);

  const activeAvailability = (availability ?? []).filter((a) => a.removedAt == null);

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
            <Skeleton className="aspect-[2/3] w-full rounded-[calc(var(--radius)+4px)]" />
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
          '--cover': coverHsl ?? 'var(--muted)',
          background:
            'radial-gradient(900px 420px at 22% 0%, hsl(var(--cover) / 0.35), transparent 65%), linear-gradient(180deg, hsl(var(--cover) / 0.16), hsl(var(--background)) 88%)',
        } as CSSProperties
      }
    >
      <Breadcrumb aria-label={t('media.detail.breadcrumb.ariaLabel')} className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/media">{t('media.landing.title')}</Link>
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
        />
        <div>
          <h1 className="text-[34px] leading-tight font-bold tracking-[-0.025em] text-balance">
            {title}
          </h1>

          {!hasCoreData && isError ? (
            <InlineErrorState message={t('media.detail.hero.loadError')} onRetry={onRetry} />
          ) : !hasCoreData ? (
            <HeroBodySkeleton />
          ) : (
            <>
              {metaLine && <p className="text-muted-foreground mt-1 text-[13px]">{metaLine}</p>}

              {availability && availability.length > 0 && (
                <div className="mt-3.5 flex flex-col gap-1.5">
                  {availability.map((entry) => {
                    const server = serverById.get(entry.serverId);
                    const removed = entry.removedAt != null;
                    const dateText = removed
                      ? t('media.detail.hero.availability.addedRemoved', {
                          added: format(new Date(entry.addedAt), 'MMM d, yyyy'),
                          removed: format(new Date(entry.removedAt as string), 'MMM d, yyyy'),
                        })
                      : t('media.detail.hero.availability.added', {
                          date: format(new Date(entry.addedAt), 'MMM d, yyyy'),
                        });
                    // A witnessed replacement tells the swap as one line, dated by
                    // the removal event rather than the server's claimed added date
                    const caption =
                      entry.replaces && !removed
                        ? joinMeta([
                            t('media.detail.hero.availability.added', {
                              date: format(new Date(entry.replaces.addedAt), 'MMM d, yyyy'),
                            }),
                            entry.replaces.videoResolution,
                            entry.replaces.fileSize != null
                              ? formatBytes(entry.replaces.fileSize, 1, { minUnit: 'GB' })
                              : null,
                            t('media.detail.hero.availability.replaced', {
                              date: format(new Date(entry.replaces.removedAt), 'MMM d, yyyy'),
                            }),
                            entry.videoResolution,
                            entry.fileSize != null
                              ? formatBytes(entry.fileSize, 1, { minUnit: 'GB' })
                              : null,
                          ])
                        : joinMeta([
                            dateText,
                            entry.videoResolution,
                            entry.fileSize != null
                              ? formatBytes(entry.fileSize, 1, { minUnit: 'GB' })
                              : null,
                          ]);
                    return (
                      <div
                        key={`${entry.serverId}-${entry.ratingKey}`}
                        className={cn(
                          'flex flex-wrap items-center gap-2.5 text-[12.5px]',
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
                    <p className="text-muted-foreground mt-1 text-[12.5px] italic">
                      {t('media.detail.hero.removedEverywhere.caption')}
                    </p>
                  )}
                </div>
              )}

              {request && (
                <p className="text-muted-foreground mt-2 flex items-center gap-2 text-[12.5px]">
                  <img
                    src={`${BASE_URL}images/services/seerr.svg`}
                    alt=""
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                  />
                  <span>{heroRequestText(request, t as Translate)}</span>
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={onFullHistoryClick}>
                  {t('media.detail.hero.actions.fullHistory')}
                </Button>
                {!removedEverywhere && (
                  <OpenOnServerAction
                    activeAvailability={activeAvailability}
                    serverById={serverById}
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
