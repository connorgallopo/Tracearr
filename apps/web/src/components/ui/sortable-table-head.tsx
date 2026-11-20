import type { ComponentProps, ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { TableHead, tableHeadTextClasses } from '@/components/ui/table';

export type SortOrder = 'asc' | 'desc';

/** Re-clicking the active column flips it; a new column starts at its default. */
export function nextSortOrder<T extends string>(
  field: T,
  sortBy: T,
  sortOrder: SortOrder,
  defaultOrder: SortOrder = 'desc'
): SortOrder {
  if (sortBy !== field) return defaultOrder;
  return sortOrder === 'asc' ? 'desc' : 'asc';
}

interface SortableTableHeadProps<T extends string> extends Omit<ComponentProps<'th'>, 'onClick'> {
  field: T;
  sortBy: T | undefined;
  sortOrder: SortOrder | undefined;
  onSort: (field: T) => void;
  children: ReactNode;
}

export function SortableTableHead<T extends string>({
  field,
  sortBy,
  sortOrder,
  onSort,
  className,
  children,
  ...props
}: SortableTableHeadProps<T>) {
  const active = sortBy === field;

  return (
    <TableHead
      aria-sort={active ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('px-0', className)}
      {...props}
    >
      {/* A label longer than its column truncates, so the header stays inside a fixed-layout column */}
      <Button
        variant="ghost"
        size="sm"
        className={cn(tableHeadTextClasses, 'hover:text-foreground h-8 max-w-full')}
        title={typeof children === 'string' ? children : undefined}
        onClick={() => onSort(field)}
      >
        <span className="truncate">{children}</span>
        {active ? (
          sortOrder === 'asc' ? (
            <ArrowUp />
          ) : (
            <ArrowDown />
          )
        ) : (
          <ArrowUpDown className="opacity-50" />
        )}
      </Button>
    </TableHead>
  );
}
