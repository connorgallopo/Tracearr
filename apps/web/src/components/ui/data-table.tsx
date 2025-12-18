import { useState, useMemo } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type PaginationState,
  type FilterFn,
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  pageSize?: number;
  onRowClick?: (row: TData) => void;
  emptyMessage?: string;
  className?: string;
  // Server-side pagination props
  pageCount?: number;
  page?: number;
  onPageChange?: (page: number) => void;
  isLoading?: boolean;
  // Filtering props
  filterColumn?: string;
  filterValue?: string;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  pageSize = 10,
  onRowClick,
  emptyMessage = 'No results found.',
  className,
  pageCount,
  page,
  onPageChange,
  isLoading,
  filterColumn,
  filterValue,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: page ? page - 1 : 0,
    pageSize,
  });

  const isServerPaginated = pageCount !== undefined && onPageChange !== undefined;

  // Custom filter function that searches in the specified column
  const globalFilterFn: FilterFn<TData> = useMemo(() => {
    return (row, _columnId, filterValue: string) => {
      if (!filterColumn || !filterValue) return true;
      const cellValue = row.getValue(filterColumn);
      if (cellValue == null) return false;
      return String(cellValue).toLowerCase().includes(filterValue.toLowerCase());
    };
  }, [filterColumn]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: isServerPaginated ? undefined : getPaginationRowModel(),
    globalFilterFn,
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    manualPagination: isServerPaginated,
    pageCount: isServerPaginated ? pageCount : undefined,
    state: {
      sorting,
      globalFilter: filterValue ?? '',
      pagination: isServerPaginated ? { pageIndex: (page ?? 1) - 1, pageSize } : pagination,
    },
  });

  const handlePageChange = (newPage: number) => {
    if (isServerPaginated && onPageChange) {
      onPageChange(newPage);
    }
  };

  const currentPage = isServerPaginated ? page : pagination.pageIndex + 1;
  const totalPages = isServerPaginated ? pageCount : table.getPageCount();
  const canPreviousPage = isServerPaginated ? (page ?? 1) > 1 : table.getCanPreviousPage();
  const canNextPage = isServerPaginated ? (page ?? 1) < (pageCount ?? 1) : table.getCanNextPage();

  return (
    <div className={cn('space-y-4', className)}>
      <div className="rounded-md border">
        <Table>
          <TableHeader className="bg-muted/50">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="px-4 py-3">
                    {header.isPlaceholder ? null : (
                      <div
                        className={cn(
                          'flex items-center gap-2',
                          header.column.getCanSort() &&
                            'hover:text-foreground cursor-pointer select-none'
                        )}
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <span className="ml-1">
                            {header.column.getIsSorted() === 'asc' ? (
                              <ChevronUp className="h-4 w-4" />
                            ) : header.column.getIsSorted() === 'desc' ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronsUpDown className="h-4 w-4 opacity-50" />
                            )}
                          </span>
                        )}
                      </div>
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-muted-foreground py-10 text-center"
                >
                  Loading...
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(onRowClick && 'cursor-pointer')}
                  onClick={() => onRowClick?.(row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-4 py-3">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="text-muted-foreground py-10 text-center"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-sm">
          Page {currentPage ?? 1} of {totalPages}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (isServerPaginated) {
                handlePageChange((page ?? 1) - 1);
              } else {
                table.previousPage();
              }
            }}
            disabled={!canPreviousPage}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (isServerPaginated) {
                handlePageChange((page ?? 1) + 1);
              } else {
                table.nextPage();
              }
            }}
            disabled={!canNextPage}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
