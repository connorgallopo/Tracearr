import { useTranslation } from 'react-i18next';
import type { ServerType } from '@tracearr/shared';
import { formatList } from '@/lib/listFormat';
import { cn } from '@/lib/utils';
import { dedupeServersById } from './dedupeServersById';

export interface ServerDotEntry {
  serverId: string;
  name: string;
  type: ServerType;
  color?: string | null;
}

interface ServerDotsProps {
  servers: ServerDotEntry[];
  className?: string;
}

/**
 * Calm per-card server indicator: a row of decorative dots carrying one
 * combined aria-label ("On Plex and Jellyfin") rather than per-dot labels,
 * since the dots themselves are not individually distinguishable visually.
 */
export function ServerDots({ servers: rawServers, className }: ServerDotsProps) {
  const { t, i18n } = useTranslation('pages');
  const servers = dedupeServersById(rawServers);

  if (servers.length === 0) return null;

  const names = servers.map((server) => server.name);
  const label = t('media.posterCard.onServers', { servers: formatList(i18n.language, names) });

  return (
    <span className={cn('inline-flex items-center gap-1', className)} role="img" aria-label={label}>
      {servers.map((server) => (
        <span
          key={server.serverId}
          aria-hidden="true"
          className="bg-muted-foreground h-1.5 w-1.5 shrink-0 rounded-full"
          style={server.color ? { backgroundColor: server.color } : undefined}
        />
      ))}
    </span>
  );
}
