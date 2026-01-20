import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QualityTrendProps {
  currentPct1080Plus: number;
  previousPct1080Plus: number;
  label?: string;
}

export function QualityTrend({
  currentPct1080Plus,
  previousPct1080Plus,
  label = 'vs start of period',
}: QualityTrendProps) {
  const change = currentPct1080Plus - previousPct1080Plus;

  // Use threshold to avoid noise from tiny fluctuations
  const isPositive = change > 0.5;
  const isNegative = change < -0.5;
  const isNeutral = !isPositive && !isNegative;

  const Icon = isNeutral ? Minus : isPositive ? TrendingUp : TrendingDown;
  const colorClass = isNeutral
    ? 'text-muted-foreground'
    : isPositive
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400';

  return (
    <div className={cn('flex items-center gap-1.5', colorClass)}>
      <Icon className="h-4 w-4" />
      <span className="text-sm font-medium">
        {isPositive && '+'}
        {change.toFixed(1)}%
      </span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </div>
  );
}
