import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import { LayoutBanner } from './LayoutBanner';

export function BasemapBanner() {
  const { t } = useTranslation('pages');

  const { data } = useQuery({
    queryKey: ['basemap-status'],
    queryFn: () => api.map.getBasemapStatus(),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  if (!data || data.installed) return null;

  return <LayoutBanner variant="destructive">{t('map.badMounts')}</LayoutBanner>;
}
