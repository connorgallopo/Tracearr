/**
 * Summary statistics display for history page.
 * Shows aggregate totals for filtered results.
 */

import { Play, Clock, Users, Film } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import type { HistoryAggregates as AggregatesType } from '@tracearr/shared';

interface Props {
  aggregates?: AggregatesType;
  total?: number;
  isLoading?: boolean;
}

// Format duration in human readable format (longer form for stats)
function formatWatchTime(ms: number): string {
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
function formatNumber(n: number): string {
  return n.toLocaleString();
}

interface StatCardProps {
  icon: typeof Play;
  label: string;
  value: string;
  subValue?: string;
  isLoading?: boolean;
}

function StatCard({ icon: Icon, label, value, subValue, isLoading }: StatCardProps) {
  return (
    <div className="bg-card flex items-center gap-3 rounded-lg border p-3">
      <div className="bg-primary/10 flex h-9 w-9 items-center justify-center rounded-md">
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
}

export function HistoryAggregates({ aggregates, total, isLoading }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        icon={Play}
        label="Total Plays"
        value={formatNumber(total ?? 0)}
        isLoading={isLoading}
      />
      <StatCard
        icon={Clock}
        label="Watch Time"
        value={formatWatchTime(aggregates?.totalWatchTimeMs ?? 0)}
        isLoading={isLoading}
      />
      <StatCard
        icon={Users}
        label="Unique Users"
        value={formatNumber(aggregates?.uniqueUsers ?? 0)}
        isLoading={isLoading}
      />
      <StatCard
        icon={Film}
        label="Unique Titles"
        value={formatNumber(aggregates?.uniqueContent ?? 0)}
        isLoading={isLoading}
      />
    </div>
  );
}
