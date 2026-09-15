import { MonitorOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

export function MapUnavailable({ className, compact }: { className?: string; compact?: boolean }) {
  const { t } = useTranslation(['pages']);
  return (
    <div
      className={cn(
        'bg-muted/30 text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-2 rounded-lg px-4 text-center',
        className
      )}
    >
      <MonitorOff className={compact ? 'h-4 w-4' : 'h-6 w-6'} />
      <p className="text-sm font-medium">{t('map.webglUnavailable')}</p>
      {!compact && <p className="max-w-xs text-xs">{t('map.webglHint')}</p>}
    </div>
  );
}
