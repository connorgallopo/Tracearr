import { Server } from 'lucide-react';
import { cn } from '@/lib/utils';

// Import server type from shared
import type { ServerType } from '@tracearr/shared';

interface MediaServerIconProps {
  /** Server type: 'plex', 'jellyfin', or 'emby' */
  type: ServerType;
  /** CSS class name for sizing (e.g., "h-4 w-4") */
  className?: string;
  /** Alt text for accessibility */
  alt?: string;
}

/**
 * Displays the appropriate icon for a media server type.
 * Falls back to generic Server icon if type is unknown.
 */
export function MediaServerIcon({ type, className, alt }: MediaServerIconProps) {
  const iconPath = getIconPath(type);

  if (!iconPath) {
    // Fallback to generic server icon
    return <Server className={className} />;
  }

  return (
    <img src={iconPath} alt={alt ?? `${type} server`} className={cn('object-contain', className)} />
  );
}

function getIconPath(type: ServerType): string | null {
  switch (type) {
    case 'plex':
      return '/images/servers/plex.png';
    case 'jellyfin':
      return '/images/servers/jellyfin.png';
    case 'emby':
      return '/images/servers/emby.png';
    default:
      return null;
  }
}
