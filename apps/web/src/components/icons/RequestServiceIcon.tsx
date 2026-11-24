import { assertNever, type RequestServiceType, type ServerType } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { BASE_URL } from '@/lib/basePath';
import { mediaServerIconPath } from './MediaServerIcon';

interface RequestServiceIconProps {
  type: RequestServiceType;
  /** The server the service belongs to; a server's own requests show its logo. */
  serverType: ServerType;
  className?: string;
}

/** The logo of the service a request goes through; decorative, the text beside it names it. */
export function RequestServiceIcon({ type, serverType, className }: RequestServiceIconProps) {
  return (
    <img
      src={getIconPath(type, serverType)}
      alt=""
      aria-hidden="true"
      className={cn('object-contain', className)}
    />
  );
}

function getIconPath(type: RequestServiceType, serverType: ServerType): string {
  switch (type) {
    case 'seerr':
      return `${BASE_URL}images/services/seerr.svg`;
    case 'server':
      return mediaServerIconPath(serverType);
    default:
      return assertNever(type);
  }
}
