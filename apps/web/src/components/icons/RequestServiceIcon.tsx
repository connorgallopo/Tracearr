import { assertNever, type RequestServiceType } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { BASE_URL } from '@/lib/basePath';
import { mediaServerIconPath } from './MediaServerIcon';

interface RequestServiceIconProps {
  type: RequestServiceType;
  className?: string;
}

/** The logo of the service a request goes through; decorative, the text beside it names it. */
export function RequestServiceIcon({ type, className }: RequestServiceIconProps) {
  return (
    <img
      src={getIconPath(type)}
      alt=""
      aria-hidden="true"
      className={cn('object-contain', className)}
    />
  );
}

function getIconPath(type: RequestServiceType): string {
  switch (type) {
    case 'seerr':
      return `${BASE_URL}images/services/seerr.svg`;
    case 'tofa':
      return mediaServerIconPath('tofa');
    default:
      return assertNever(type);
  }
}
