import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProfileFilterOption } from '@tracearr/shared';

/** A profile's name, marked when the server no longer lists it. */
export function useProfileLabel() {
  const { t } = useTranslation('common');
  return useCallback(
    (profile: { name: string; removed: boolean }) =>
      profile.removed ? t('labels.profileRemoved', { name: profile.name }) : profile.name,
    [t]
  );
}

/** How a profile option is listed: a main profile as its account, any other by its own name. */
export function useProfileOptionLabel() {
  const profileLabel = useProfileLabel();
  return useCallback(
    (option: ProfileFilterOption) => (option.main ? option.accountUsername : profileLabel(option)),
    [profileLabel]
  );
}
