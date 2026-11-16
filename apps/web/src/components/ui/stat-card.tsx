import type { LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

interface StatCardProps {
  icon?: LucideIcon;
  label: string;
  value: string | number;
  /** Context after the label on the same line, e.g. "Plays · 5 sessions". */
  subValue?: string;
  /** Percent change against the prior period; the label names the comparison beside it. */
  delta?: { value: number; label?: string };
  /** Muted text after the value, e.g. "of 43". */
  valueSuffix?: string;
  isLoading?: boolean;
  href?: string;
  /** Cut a long value (a show title) with an ellipsis instead of letting it overflow. */
  truncateValue?: boolean;
  /** Tighter padding, a smaller chip and an 18px value, for tiles inside a sheet. */
  compact?: boolean;
}

const deltaFormat = new Intl.NumberFormat(undefined, {
  signDisplay: 'exceptZero',
  maximumFractionDigits: 0,
});

function deltaTone(value: number): string {
  const rounded = Math.round(value);
  if (rounded > 0) return 'text-success';
  if (rounded < 0) return 'text-destructive';
  return 'text-muted-foreground';
}

/**
 * The one stat tile: a value line carrying the delta and its comparison, then a label line
 * carrying the sub value. It fills its grid cell, so every tile in a row is one height, and steps
 * up to the raised surface when it sits inside a card or a sheet.
 */
export function StatCard({
  icon: Icon,
  label,
  value,
  subValue,
  delta,
  valueSuffix,
  isLoading,
  href,
  truncateValue,
  compact,
}: StatCardProps) {
  const card = (
    <div
      className={cn(
        'bg-card [[data-slot=card]_&]:bg-card-raised [[data-slot=sheet-content]_&]:bg-card-raised flex h-full items-center gap-3 rounded-xl border',
        compact ? 'px-3 py-2' : 'p-3',
        href && 'card-hover'
      )}
    >
      {Icon && (
        <div
          className={cn(
            'bg-primary/10 flex shrink-0 items-center justify-center rounded-lg',
            compact ? 'size-7' : 'size-8'
          )}
        >
          <Icon className={cn('text-primary', compact ? 'size-3.5' : 'size-4')} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        {isLoading ? (
          <>
            <Skeleton className="h-5 w-16" />
            <Skeleton className="mt-1.5 h-3 w-20" />
          </>
        ) : (
          <>
            <div
              className={cn(
                'font-semibold tabular-nums',
                compact ? 'text-lg' : 'text-xl',
                truncateValue && 'truncate'
              )}
            >
              {value}
              {valueSuffix && (
                <span className="text-muted-foreground ml-1 text-xs font-normal">
                  {valueSuffix}
                </span>
              )}
              {delta && (
                <span className={cn('ml-2 text-xs font-medium', deltaTone(delta.value))}>
                  {deltaFormat.format(delta.value)}%
                </span>
              )}
              {delta?.label && (
                <span className="text-muted-foreground ml-1 text-xs font-normal">
                  {delta.label}
                </span>
              )}
            </div>
            <div className="text-muted-foreground text-dense">
              <span>{label}</span>
              {subValue && (
                <>
                  {' · '}
                  <span>{subValue}</span>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  return href ? (
    <Link
      to={href}
      className="group focus-visible:ring-ring focus-visible:ring-offset-background block h-full rounded-xl focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {card}
    </Link>
  ) : (
    card
  );
}

// Format large numbers with commas
export function formatNumber(n: number): string {
  return n.toLocaleString();
}
