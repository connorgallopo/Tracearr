import { useTranslation } from 'react-i18next';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';
import { LayoutBanner } from './LayoutBanner';
import { ServerHealthBanner } from './ServerHealthBanner';
import { BasemapBanner } from './BasemapBanner';
import { IpWarningBanner } from './IpWarningBanner';

/** The strip of status banners under the header, in priority order. */
export function StatusBanners() {
  const { t } = useTranslation('pages');
  const { isUnreachable } = useMaintenanceMode();

  // The others report on data we can't refresh right now, so they'd only be stale
  if (isUnreachable) {
    return <LayoutBanner variant="warning">{t('maintenance.unreachable')}</LayoutBanner>;
  }

  return (
    <>
      <ServerHealthBanner />
      <BasemapBanner />
      <IpWarningBanner />
    </>
  );
}
