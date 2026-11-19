import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** A profile's name, marked when the server no longer lists it. */
export function useProfileLabel() {
  const { t } = useTranslation('common');
  return useCallback(
    (profile: { name: string; removed: boolean }) =>
      profile.removed ? t('labels.profileRemoved', { name: profile.name }) : profile.name,
    [t]
  );
}
