import { useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from './cn';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';
import { Table, THead, TBody, TR, TH, TD } from './Table';

export interface DataTableProps<T> {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  isLoading?: boolean;
  emptyState?: React.ReactNode;
  onRowClick?: (row: T) => void;
  /** Controlled sorting state. Pass with `onSortingChange` to control sorting. */
  sorting?: SortingState;
  /** When provided, sorting is controlled by the parent. */
  onSortingChange?: (s: SortingState) => void;
  /** Number of skeleton rows to render while loading. */
  loadingRowCount?: number;
  className?: string;
}

/**
 * Generic data table built on `@tanstack/react-table`.
 *
 * Sorting can be controlled or uncontrolled: if `onSortingChange` is provided
 * the parent owns the `sorting` state (controlled); otherwise the component
 * keeps it in internal `useState` (uncontrolled). Sortable column headers are
 * real buttons that toggle sort and expose `aria-sort` on the `<th>`.
 *
 * `columns` and `data` are passed straight to TanStack — callers should keep
 * these references stable (e.g. module-level or `useMemo`) so the table model
 * is not rebuilt on every render.
 */
export function DataTable<T>({
  columns,
  data,
  isLoading = false,
  emptyState,
  onRowClick,
  sorting,
  onSortingChange,
  loadingRowCount = 5,
  className,
}: DataTableProps<T>) {
  const isControlled = onSortingChange !== undefined;
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const sortingState = isControlled ? (sorting ?? []) : internalSorting;

  const handleSortingChange: OnChangeFn<SortingState> = (updater) => {
    const next = typeof updater === 'function' ? updater(sortingState) : updater;
    if (isControlled) {
      onSortingChange(next);
    } else {
      setInternalSorting(next);
    }
  };

  const table = useReactTable<T>({
    data,
    columns,
    state: { sorting: sortingState },
    onSortingChange: handleSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const columnCount = columns.length || 1;
  const rows = table.getRowModel().rows;
  const showEmpty = !isLoading && data.length === 0;

  return (
    <div className={cn('w-full overflow-x-auto rounded-xl border border-border', className)}>
      <Table className="dt-responsive">
        <THead>
          {table.getHeaderGroups().map((headerGroup) => (
            <TR key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sortDir = header.column.getIsSorted(); // false | 'asc' | 'desc'
                const ariaSort = !sortDir
                  ? 'none'
                  : sortDir === 'asc'
                    ? 'ascending'
                    : 'descending';

                if (header.isPlaceholder) {
                  return <TH key={header.id} aria-hidden="true" />;
                }

                const content = flexRender(
                  header.column.columnDef.header,
                  header.getContext(),
                );

                if (!canSort) {
                  return <TH key={header.id}>{content}</TH>;
                }

                return (
                  <TH key={header.id} aria-sort={ariaSort}>
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={cn(
                        'inline-flex items-center gap-1 text-micro uppercase tracking-[inherit]',
                        'transition-colors duration-fast hover:text-foreground',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--ring] rounded-sm',
                      )}
                    >
                      {content}
                      <span className="inline-flex w-3 justify-center" aria-hidden="true">
                        {sortDir === 'asc' && <ChevronUp className="h-3 w-3" />}
                        {sortDir === 'desc' && <ChevronDown className="h-3 w-3" />}
                      </span>
                    </button>
                  </TH>
                );
              })}
            </TR>
          ))}
        </THead>
        <TBody>
          {isLoading
            ? Array.from({ length: loadingRowCount }).map((_, rowIndex) => (
                <TR key={`skeleton-${rowIndex}`} className="hover:bg-transparent">
                  {Array.from({ length: columnCount }).map((__, colIndex) => (
                    <TD key={`skeleton-${rowIndex}-${colIndex}`}>
                      <Skeleton className="h-4 w-full" />
                    </TD>
                  ))}
                </TR>
              ))
            : rows.map((row) => {
                const clickable = onRowClick !== undefined;
                return (
                  <TR
                    key={row.id}
                    {...(clickable
                      ? {
                          role: 'button',
                          tabIndex: 0,
                          onClick: () => onRowClick(row.original),
                          onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick(row.original);
                            }
                          },
                        }
                      : {})}
                    className={cn(clickable && 'cursor-pointer')}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const header = cell.column.columnDef.header;
                      const label = typeof header === 'string' && header ? header : undefined;
                      return (
                        <TD key={cell.id} data-label={label}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TD>
                      );
                    })}
                  </TR>
                );
              })}
        </TBody>
      </Table>

      {showEmpty && (
        <div className="p-2">
          {emptyState ?? <EmptyState title="No data" description="There is nothing to show yet." />}
        </div>
      )}
    </div>
  );
}
