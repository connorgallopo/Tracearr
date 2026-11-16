import { useTranslation } from 'react-i18next';
import { Eye, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useStopViewingAs } from '@/hooks/queries/useImpersonation';
import { LayoutBanner, LayoutBannerAction } from './LayoutBanner';

export function ImpersonationBanner() {
  const { t } = useTranslation('pages');
  const { user } = useAuth();
  const stop = useStopViewingAs();

  if (!user?.impersonatedBy) return null;
  const name = user.name ?? user.username;

  return (
    <LayoutBanner variant="warning" icon={Eye}>
      <div className="flex items-center justify-between gap-4">
        <span className="flex-1">{stop.error?.message ?? t('impersonation.banner', { name })}</span>
        <LayoutBannerAction
          disabled={stop.isPending}
          aria-label={t('impersonation.stopLabel', { name })}
          onClick={() => stop.mutate()}
        >
          {stop.isPending && <Loader2 className="animate-spin" />}
          {t('impersonation.stop')}
        </LayoutBannerAction>
      </div>
    </LayoutBanner>
  );
}
