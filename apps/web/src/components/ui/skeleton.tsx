import { cn } from '@/lib/utils';

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return <div className={cn('bg-muted animate-pulse rounded-md', className)} {...props} />;
}

// Card skeleton for dashboard stats
export function StatsCardSkeleton() {
  return (
    <div className="bg-card rounded-lg border p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-4 rounded-full" />
      </div>
      <Skeleton className="mt-4 h-8 w-16" />
      <Skeleton className="mt-2 h-3 w-32" />
    </div>
  );
}

// Table row skeleton
export function TableRowSkeleton({ columns = 5 }: { columns?: number }) {
  return (
    <tr className="border-b">
      {Array.from({ length: columns }).map((_, i) => (
        <td key={i} className="p-4">
          <Skeleton className="h-4 w-full" />
        </td>
      ))}
    </tr>
  );
}

// List item skeleton
export function ListItemSkeleton() {
  return (
    <div className="flex items-center gap-4 p-4">
      <Skeleton className="h-10 w-10 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

// Chart skeleton
export function ChartSkeleton({ height = 200 }: { height?: number }) {
  return (
    <div className="w-full" style={{ height }}>
      <Skeleton className="h-full w-full" />
    </div>
  );
}

// Library stats overview - 4 KPI cards in grid
export function LibraryStatsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <StatsCardSkeleton key={i} />
      ))}
    </div>
  );
}

// Library chart section - card with title area and chart
export function LibraryChartSkeleton({ height = 300 }: { height?: number }) {
  return (
    <div className="bg-card rounded-lg border p-6">
      <div className="mb-4 flex items-center justify-between">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
      <ChartSkeleton height={height} />
    </div>
  );
}

// Library summary card - for duplicates, stale, ROI summaries
export function LibrarySummaryCardSkeleton() {
  return (
    <div className="bg-card rounded-lg border p-6">
      <Skeleton className="mb-2 h-4 w-24" />
      <Skeleton className="mb-4 h-8 w-20" />
      <div className="space-y-2">
        <div className="flex justify-between">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="flex justify-between">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    </div>
  );
}

// Library table section - header and rows
export function LibraryTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="bg-card rounded-lg border">
      <div className="border-b p-4">
        <Skeleton className="h-5 w-32" />
      </div>
      <table className="w-full">
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRowSkeleton key={i} columns={5} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
