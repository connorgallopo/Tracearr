import { useTranslation } from 'react-i18next';
import { isStaff as staffRole } from '@tracearr/shared';
import { useAuth } from '@/hooks/useAuth';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';
import { LayoutBanner } from './LayoutBanner';
import { ImpersonationBanner } from './ImpersonationBanner';
import { ServerHealthBanner } from './ServerHealthBanner';
import { BasemapBanner } from './BasemapBanner';
import { IpWarningBanner } from './IpWarningBanner';
import { StorageWarningBanner } from './StorageWarningBanner';

/** The strip of status banners under the header, in priority order. */
export function StatusBanners() {
  const { t } = useTranslation('pages');
  const { user } = useAuth();
  const { isUnreachable } = useMaintenanceMode();
  // These report on the operator's setup, and members cannot read the endpoints behind them
  const isStaff = !!user && staffRole(user.role);

  return (
    <>
      <ImpersonationBanner />
      {isUnreachable ? (
        // The others report on data we can't refresh right now, so they'd only be stale
        <LayoutBanner variant="warning">{t('maintenance.unreachable')}</LayoutBanner>
      ) : (
        isStaff && (
          <>
            <ServerHealthBanner />
            <BasemapBanner />
            <IpWarningBanner />
            {user.role === 'owner' && <StorageWarningBanner />}
          </>
        )
      )}
    </>
  );
}
