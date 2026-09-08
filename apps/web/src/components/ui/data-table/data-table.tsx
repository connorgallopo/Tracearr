import { createContext, use, useMemo, type CSSProperties, type ReactNode } from 'react';
import { FlexRender, type Row } from '@tanstack/react-table';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { EmptyState } from '@/components/ui/empty-state';
import type { DataTableColumnMeta, DataTableFeatures, DataTableInstance } from './features';

/**
 * The one scroll clamp for contained tables. Bounding the app shell later is a
 * change to this constant rather than to every table that scrolls.
 */
export const DATA_TABLE_VIEWPORT_MAX_HEIGHT = 'clamp(400px, 70vh, calc(100vh - 200px))';

/**
 * Row size is not uniform across pages: /users carries a 40px avatar per row
 * while the library and stats tables are text-only. Density is one axis on the
 * Root rather than a flag on each column, so changing it never touches a column
 * definition.
 */
export type DataTableDensity = 'comfortable' | 'default' | 'compact';

/**
 * The header type scale, split out because it varies independently of density.
 * `micro` is the scale DeadWeightTable and Genres hand-wrote eight times.
 */
export type DataTableHeaderVariant = 'default' | 'micro';

interface DataTableChrome {
  density: DataTableDensity;
  headerVariant: DataTableHeaderVariant;
}

const ChromeContext = createContext<DataTableChrome>({
  density: 'default',
  headerVariant: 'default',
});

const HEADER_PADDING: Record<DataTableDensity, string> = {
  comfortable: 'h-auto px-4 py-4',
  default: 'h-auto px-4 py-3',
  compact: 'h-auto px-3 py-2',
};

const CELL_PADDING: Record<DataTableDensity, string> = {
  comfortable: 'px-4 py-4',
  default: 'px-4 py-3',
  compact: 'px-3 py-1.5',
};

const FLUSH_OFFSET: Record<DataTableDensity, string> = {
  comfortable: '-mx-4 -mb-4',
  default: '-mx-4 -mb-3',
  compact: '-mx-3 -mb-1.5',
};

const HEADER_TEXT: Record<DataTableHeaderVariant, string | undefined> = {
  default: undefined,
  micro: 'text-[10.5px] font-semibold tracking-[0.07em]',
};

function metaAlignClasses(meta: DataTableColumnMeta | undefined): string | undefined {
  if (!meta) return undefined;
  const align = meta.align ?? (meta.numeric ? 'end' : undefined);
  return cn(
    align === 'center' && 'text-center',
    align === 'end' && 'text-right',
    meta.numeric && 'tabular-nums'
  );
}

function metaWidthStyle(meta: DataTableColumnMeta | undefined): CSSProperties | undefined {
  return meta?.width ? { width: meta.width } : undefined;
}

interface DataTableRootProps {
  density?: DataTableDensity;
  headerVariant?: DataTableHeaderVariant;
  className?: string;
  children: ReactNode;
}

/** Draws no frame: every call site already sits inside a Card. */
export function DataTableRoot({
  density = 'default',
  headerVariant = 'default',
  className,
  children,
}: DataTableRootProps) {
  const chrome = useMemo(() => ({ density, headerVariant }), [density, headerVariant]);
  return (
    <ChromeContext value={chrome}>
      <div className={cn('space-y-4', className)}>{children}</div>
    </ChromeContext>
  );
}

interface DataTableViewportProps {
  /** Clamps the height and scrolls inside the table instead of the page. */
  contained?: boolean;
  /**
   * Cancels the cell padding against the padding of a surrounding CardContent,
   * so the first column lines up with the card title instead of sitting inset
   * by one more gutter.
   */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function DataTableViewport({
  contained = false,
  flush = false,
  className,
  children,
}: DataTableViewportProps) {
  const { density } = use(ChromeContext);
  return (
    <div
      data-slot="data-table-viewport"
      className={cn(
        'relative w-full overflow-auto',
        contained && 'scrollbar-thin',
        flush && FLUSH_OFFSET[density],
        className
      )}
      style={contained ? { maxHeight: DATA_TABLE_VIEWPORT_MAX_HEIGHT } : undefined}
    >
      <table data-slot="table" className="w-full caption-bottom text-sm">
        {children}
      </table>
    </div>
  );
}

interface DataTableHeaderProps<TData extends object> {
  table: DataTableInstance<TData>;
  className?: string;
}

export function DataTableHeader<TData extends object>({
  table,
  className,
}: DataTableHeaderProps<TData>) {
  const { density, headerVariant } = use(ChromeContext);

  return (
    <thead
      data-slot="table-header"
      // A collapsed border belongs to the table box and does not travel with a
      // sticky thead, so the rule under the header has to be a shadow.
      className={cn(
        'bg-card sticky top-0 z-10 shadow-[inset_0_-1px_0_0_hsl(var(--border))]',
        className
      )}
    >
      {table.getHeaderGroups().map((headerGroup) => (
        <tr key={headerGroup.id}>
          {headerGroup.headers.map((header) => {
            const meta = header.column.columnDef.meta;
            const classes = cn(
              HEADER_PADDING[density],
              HEADER_TEXT[headerVariant],
              metaAlignClasses(meta),
              meta?.headerClassName
            );
            const style = metaWidthStyle(meta);

            if (header.isPlaceholder) {
              return <TableHead key={header.id} className={classes} style={style} />;
            }

            if (header.column.getCanSort()) {
              const sorted = header.column.getIsSorted();
              return (
                <SortableTableHead
                  key={header.id}
                  field={header.column.id}
                  sortBy={sorted ? header.column.id : undefined}
                  sortOrder={sorted === false ? undefined : sorted}
                  onSort={() => header.column.toggleSorting()}
                  className={classes}
                  style={style}
                >
                  <FlexRender header={header} />
                </SortableTableHead>
              );
            }

            return (
              <TableHead key={header.id} className={classes} style={style}>
                <FlexRender header={header} />
              </TableHead>
            );
          })}
        </tr>
      ))}
    </thead>
  );
}

interface DataTableRowProps<TData extends object> {
  row: Row<DataTableFeatures, TData>;
  onRowClick?: (row: TData) => void;
  getRowStyle?: (row: TData) => CSSProperties | undefined;
  className?: string;
}

export function DataTableRow<TData extends object>({
  row,
  onRowClick,
  getRowStyle,
  className,
}: DataTableRowProps<TData>) {
  const { density } = use(ChromeContext);
  const clickable = onRowClick !== undefined;

  return (
    <TableRow
      data-state={row.getIsSelected() ? 'selected' : undefined}
      className={cn(
        clickable &&
          'focus-visible:outline-ring cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2',
        className
      )}
      style={getRowStyle?.(row.original)}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onRowClick(row.original) : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              // Cells hold their own controls; a key pressed on one of those
              // activates it rather than opening the row.
              if (event.target !== event.currentTarget) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onRowClick(row.original);
            }
          : undefined
      }
    >
      {row.getVisibleCells().map((cell) => {
        const meta = cell.column.columnDef.meta;
        return (
          <TableCell
            key={cell.id}
            className={cn(CELL_PADDING[density], metaAlignClasses(meta), meta?.cellClassName)}
            style={metaWidthStyle(meta)}
          >
            <FlexRender cell={cell} />
          </TableCell>
        );
      })}
    </TableRow>
  );
}

interface DataTableEmptyProps<TData extends object> {
  table: DataTableInstance<TData>;
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function DataTableEmpty<TData extends object>({
  table,
  icon,
  title,
  description,
  action,
}: DataTableEmptyProps<TData>) {
  return (
    <tbody data-slot="table-body">
      <tr>
        {/* Bare td: TableCell's p-2 would stack on the padding EmptyState already carries. */}
        <td colSpan={table.getVisibleLeafColumns().length}>
          <EmptyState icon={icon} title={title} description={description}>
            {action}
          </EmptyState>
        </td>
      </tr>
    </tbody>
  );
}

interface DataTableSkeletonProps<TData extends object> {
  table: DataTableInstance<TData>;
  rows?: number;
  /** Names the busy region for assistive tech. */
  label?: string;
}

/** Mirrors the real column layout rather than collapsing to one status row. */
export function DataTableSkeleton<TData extends object>({
  table,
  rows = 5,
  label,
}: DataTableSkeletonProps<TData>) {
  const { density } = use(ChromeContext);
  const columns = table.getVisibleLeafColumns();

  return (
    <tbody data-slot="table-body" aria-busy="true" aria-label={label || undefined}>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <TableRow key={rowIndex}>
          {columns.map((column) => {
            const meta = column.columnDef.meta;
            return (
              <TableCell
                key={column.id}
                className={cn(CELL_PADDING[density], meta?.cellClassName)}
                style={metaWidthStyle(meta)}
              >
                <Skeleton className="h-4 w-full" />
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </tbody>
  );
}

interface DataTableBodyProps<TData extends object> {
  table: DataTableInstance<TData>;
  isLoading?: boolean;
  skeletonRows?: number;
  /** Names the busy region while `isLoading` is set. */
  loadingLabel?: string;
  empty?: ReactNode;
  onRowClick?: (row: TData) => void;
  getRowStyle?: (row: TData) => CSSProperties | undefined;
  rowClassName?: string;
  className?: string;
}

export function DataTableBody<TData extends object>({
  table,
  isLoading = false,
  skeletonRows,
  loadingLabel,
  empty,
  onRowClick,
  getRowStyle,
  rowClassName,
  className,
}: DataTableBodyProps<TData>) {
  if (isLoading) {
    return <DataTableSkeleton table={table} rows={skeletonRows} label={loadingLabel} />;
  }

  const rows = table.getRowModel().rows;
  if (rows.length === 0) {
    return <>{empty}</>;
  }

  return (
    <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)}>
      {rows.map((row) => (
        <DataTableRow
          key={row.id}
          row={row}
          onRowClick={onRowClick}
          getRowStyle={getRowStyle}
          className={rowClassName}
        />
      ))}
    </tbody>
  );
}
