/**
 * Reusable stat card component for displaying metrics.
 * Used on Dashboard and History pages.
 */

import type { LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  value: string | number;
  subValue?: string;
  isLoading?: boolean;
  href?: string;
}

export function StatCard({ icon: Icon, label, value, subValue, isLoading, href }: StatCardProps) {
  const card = (
    <div
      className={cn('bg-card flex items-center gap-3 rounded-lg border p-3', href && 'card-hover')}
    >
      <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
        <Icon className="text-primary h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        {isLoading ? (
          <>
            <Skeleton className="h-5 w-16" />
            <Skeleton className="mt-1 h-3 w-12" />
          </>
        ) : (
          <>
            <div className="text-lg font-semibold tabular-nums">{value}</div>
            <div className="text-muted-foreground text-xs">
              {label}
              {subValue && <span className="ml-1">({subValue})</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );

  return href ? (
    <Link
      to={href}
      className="group focus-visible:ring-ring focus-visible:ring-offset-background block rounded-lg focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {card}
    </Link>
  ) : (
    card
  );
}

// Format duration in human readable format
export function formatWatchTime(ms: number): string {
  if (!ms) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days > 0) {
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Format large numbers with commas
export function formatNumber(n: number): string {
  return n.toLocaleString();
}
