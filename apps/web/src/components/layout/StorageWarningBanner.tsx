import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDismissStorageWarning, useStorageWarning } from '@/hooks/queries';
import { LayoutBanner, LayoutBannerAction } from './LayoutBanner';
import { StorageWarningDialog, affectsDatabase } from './StorageWarningDialog';

/** Supervised Unraid installs whose data volumes sit on the FUSE user share. Owner only. */
export function StorageWarningBanner() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const { data } = useStorageWarning();
  const dismiss = useDismissStorageWarning();

  if (!data?.applicable || data.issues.length === 0 || data.dismissed) return null;

  return (
    <LayoutBanner variant="warning">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="flex-1">
          {t(
            affectsDatabase(data.issues)
              ? 'storageWarning.bannerDatabase'
              : 'storageWarning.bannerData'
          )}
        </span>
        <div className="flex gap-2">
          <LayoutBannerAction onClick={() => setOpen(true)}>
            {t('storageWarning.showHow')}
          </LayoutBannerAction>
          <LayoutBannerAction
            variant="ghost"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate()}
          >
            {t('storageWarning.hide')}
          </LayoutBannerAction>
        </div>
      </div>
      <StorageWarningDialog issues={data.issues} open={open} onClose={() => setOpen(false)} />
    </LayoutBanner>
  );
}
