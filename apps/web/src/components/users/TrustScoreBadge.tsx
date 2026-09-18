import { useTranslation } from 'react-i18next';
import { TRUST_LEVEL_LABEL_KEYS, trustLevel, type TrustLevel } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TrustScoreBadgeProps {
  score: number;
  showLabel?: boolean;
  className?: string;
}

const TRUST_LEVEL_VARIANTS = {
  trusted: 'success',
  caution: 'warning',
  untrusted: 'danger',
} as const satisfies Record<TrustLevel, string>;

export function TrustScoreBadge({ score, showLabel = false, className }: TrustScoreBadgeProps) {
  const { t } = useTranslation('common');
  const level = trustLevel(score);

  return (
    <Badge variant={TRUST_LEVEL_VARIANTS[level]} className={cn('gap-1', className)}>
      <span className="font-mono">{score}</span>
      {showLabel && <span>· {t(TRUST_LEVEL_LABEL_KEYS[level])}</span>}
    </Badge>
  );
}
