import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';

export function BetaBadge() {
  const { t } = useTranslation('common');

  return <Badge variant="warning">{t('beta')}</Badge>;
}
