import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TrustScoreBadgeProps {
  score: number;
  showLabel?: boolean;
  className?: string;
}

function getTrustLevel(score: number): {
  variant: 'success' | 'warning' | 'danger';
  label: string;
} {
  if (score >= 80) {
    return { variant: 'success', label: 'Trusted' };
  }
  if (score >= 50) {
    return { variant: 'warning', label: 'Caution' };
  }
  return { variant: 'danger', label: 'Untrusted' };
}

export function TrustScoreBadge({ score, showLabel = false, className }: TrustScoreBadgeProps) {
  const { variant, label } = getTrustLevel(score);

  return (
    <Badge variant={variant} className={cn('gap-1', className)}>
      <span className="font-mono">{score}</span>
      {showLabel && <span>· {label}</span>}
    </Badge>
  );
}
