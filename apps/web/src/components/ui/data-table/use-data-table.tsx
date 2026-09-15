import { useCallback, useMemo, useRef, useState } from 'react';
import type { PaginationState, RowSelectionState, SortingState } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  createDataTableColumnHelper,
  dataTableFeatures,
  type DataTableColumns,
  type DataTableInstance,
} from './features';

export const SELECT_COLUMN_ID = '_select';

const EMPTY_ROWS: never[] = [];

/**
 * Radix renders the check glyph for `indeterminate` as well as `checked`, so the
 * mixed state swaps it for a dash drawn as a pseudo-element.
 */
const INDETERMINATE_CHECKBOX_CLASSES =
  'relative data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:text-primary-foreground data-[state=indeterminate]:[&_svg]:hidden after:pointer-events-none after:absolute after:inset-x-[3px] after:top-1/2 after:h-[2px] after:-translate-y-1/2 after:rounded-full after:bg-current after:opacity-0 data-[state=indeterminate]:after:opacity-100';

export interface DataTableSelectionLabels {
  /** aria-label for the header checkbox. */
  selectAllOnPage: string;
  /** aria-label for each row checkbox. */
  selectRow: string;
}

export interface DataTableSelection<TData extends object> {
  selectedIds: ReadonlySet<string>;
  /** "Everything matching the filters" mode, which no table state can express. */
  selectAllMode?: boolean;
  onToggleRow: (row: TData) => void;
  onTogglePage: (rows: TData[]) => void;
  labels: DataTableSelectionLabels;
}

export interface DataTablePagerState {
  page: number;
  pageCount: number;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPage: (page: number) => void;
}

export interface UseDataTableOptions<TData extends object> {
  columns: DataTableColumns<TData>;
  data: TData[] | undefined;
  getRowId: (row: TData) => string;
  pageSize?: number;
  /** Total pages. Supplying it with `onPageChange` puts the table in server mode. */
  pageCount?: number;
  /** Current 1-based page, server mode only. */
  page?: number;
  onPageChange?: (page: number) => void;
  /** Supplying `onSortingChange` puts sorting in server mode. */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /**
   * Off by default so a header click flips asc/desc, matching `nextSortOrder` in
   * sortable-table-head. Server list endpoints always need an order to apply.
   */
  enableSortingRemoval?: boolean;
  selection?: DataTableSelection<TData>;
}

export interface UseDataTableResult<TData extends object> {
  table: DataTableInstance<TData>;
  pager: DataTablePagerState;
}

export function useDataTable<TData extends object>({
  columns,
  data,
  getRowId,
  pageSize = 10,
  pageCount,
  page,
  onPageChange,
  sorting,
  onSortingChange,
  enableSortingRemoval = false,
  selection,
}: UseDataTableOptions<TData>): UseDataTableResult<TData> {
  const rows = data ?? EMPTY_ROWS;

  const isServerPaginated = pageCount !== undefined && onPageChange !== undefined;
  const isServerSorted = onSortingChange !== undefined;

  const [clientPageIndex, setClientPageIndex] = useState(0);
  const [clientSorting, setClientSorting] = useState<SortingState>([]);

  const clientPagination = useMemo<PaginationState>(
    () => ({ pageIndex: clientPageIndex, pageSize }),
    [clientPageIndex, pageSize]
  );

  const selectAllMode = selection?.selectAllMode ?? false;
  const selectedIds = selection?.selectedIds;

  const rowSelection = useMemo<RowSelectionState>(() => {
    const next: RowSelectionState = {};
    if (!selectedIds && !selectAllMode) return next;
    for (const row of rows) {
      const id = getRowId(row);
      if (selectAllMode || selectedIds?.has(id)) next[id] = true;
    }
    return next;
  }, [rows, getRowId, selectedIds, selectAllMode]);

  // Read inside a callback the table owns, so it must not close over a stale render.
  const latestRef = useRef({ rows, rowSelection, getRowId, selection });
  latestRef.current = { rows, rowSelection, getRowId, selection };

  const handleRowSelectionChange = useCallback(
    (updater: RowSelectionState | ((old: RowSelectionState) => RowSelectionState)) => {
      const current = latestRef.current;
      if (!current.selection) return;
      const next = typeof updater === 'function' ? updater(current.rowSelection) : updater;
      for (const row of current.rows) {
        const id = current.getRowId(row);
        if (Boolean(current.rowSelection[id]) !== (next[id] === true)) {
          current.selection.onToggleRow(row);
        }
      }
    },
    []
  );

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const resolved = typeof updater === 'function' ? updater(sorting ?? clientSorting) : updater;
      onSortingChange?.(resolved);
      // Without a controlled `sorting` prop the header would otherwise never move.
      if (sorting === undefined) setClientSorting(resolved);
    },
    [onSortingChange, sorting, clientSorting]
  );

  const handlePaginationChange = useCallback(
    (updater: PaginationState | ((old: PaginationState) => PaginationState)) => {
      const current: PaginationState = {
        pageIndex: isServerPaginated ? (page ?? 1) - 1 : clientPageIndex,
        pageSize,
      };
      const resolved = typeof updater === 'function' ? updater(current) : updater;
      if (isServerPaginated) {
        onPageChange?.(resolved.pageIndex + 1);
      } else {
        setClientPageIndex(resolved.pageIndex);
      }
    },
    [isServerPaginated, onPageChange, page, pageSize, clientPageIndex]
  );

  const allColumns = useMemo<DataTableColumns<TData>>(() => {
    if (!selection) return columns;
    const helper = createDataTableColumnHelper<TData>();
    const selectColumn = helper.display({
      id: SELECT_COLUMN_ID,
      enableSorting: false,
      enableHiding: false,
      meta: { width: '2.75rem' },
      header: ({ table }) => {
        const allSelected = table.getIsAllPageRowsSelected();
        const someSelected = table.getIsSomePageRowsSelected();
        return (
          <Checkbox
            checked={allSelected ? true : someSelected ? 'indeterminate' : false}
            onCheckedChange={() =>
              selection.onTogglePage(table.getRowModel().rows.map((row) => row.original))
            }
            onClick={(event) => event.stopPropagation()}
            aria-label={selection.labels.selectAllOnPage}
            className={INDETERMINATE_CHECKBOX_CLASSES}
          />
        );
      },
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={() => selection.onToggleRow(row.original)}
          onClick={(event) => event.stopPropagation()}
          aria-label={selection.labels.selectRow}
        />
      ),
    });
    return [selectColumn, ...columns];
  }, [columns, selection]);

  const table = useTable<typeof dataTableFeatures, TData>({
    features: dataTableFeatures,
    columns: allColumns,
    data: rows,
    getRowId,
    manualPagination: isServerPaginated,
    manualSorting: isServerSorted,
    enableSortingRemoval,
    // v9 turns Shift-range selection on by default and this UI has no affordance for it.
    enableRowRangeSelection: false,
    enableRowSelection: selection !== undefined,
    ...(isServerPaginated ? { pageCount } : {}),
    state: {
      sorting: sorting ?? clientSorting,
      pagination: isServerPaginated ? { pageIndex: (page ?? 1) - 1, pageSize } : clientPagination,
      rowSelection,
    },
    onSortingChange: handleSortingChange,
    onPaginationChange: handlePaginationChange,
    onRowSelectionChange: handleRowSelectionChange,
  });

  const currentPage = isServerPaginated ? (page ?? 1) : clientPagination.pageIndex + 1;
  const totalPages = isServerPaginated ? (pageCount ?? 1) : table.getPageCount();

  const pager = useMemo<DataTablePagerState>(
    () => ({
      page: currentPage,
      pageCount: totalPages,
      canPrevious: currentPage > 1,
      canNext: currentPage < totalPages,
      onPrevious: () => {
        if (currentPage > 1) handlePaginationChange({ pageIndex: currentPage - 2, pageSize });
      },
      onNext: () => {
        if (currentPage < totalPages) handlePaginationChange({ pageIndex: currentPage, pageSize });
      },
      onPage: (page: number) => {
        const target = Math.min(Math.max(page, 1), totalPages);
        if (target !== currentPage) handlePaginationChange({ pageIndex: target - 1, pageSize });
      },
    }),
    [currentPage, totalPages, handlePaginationChange, pageSize]
  );

  return { table, pager };
}
