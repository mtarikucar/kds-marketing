import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from './cn';
import { IconButton } from './IconButton';

/**
 * Pagination component. Renders prev/next IconButtons and numbered page buttons.
 * - Prev button is disabled on page 1.
 * - Next button is disabled on the last page.
 * - Active page button has `aria-current="page"`.
 *
 * Page numbers are always 1-indexed.
 */
export interface PaginationProps {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  /** Max page buttons to show before collapsing with ellipsis. Default 7. */
  maxButtons?: number;
  className?: string;
}

/** Compute the window of page numbers to render. */
function getPageRange(current: number, total: number, maxButtons: number): Array<number | '...'> {
  if (total <= maxButtons) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const half = Math.floor((maxButtons - 2) / 2); // leave space for first, last, and one ellipsis pair
  let start = Math.max(2, current - half);
  let end = Math.min(total - 1, current + half);

  if (current - 1 <= half + 1) {
    start = 2;
    end = Math.min(total - 1, maxButtons - 2);
  } else if (total - current <= half + 1) {
    end = total - 1;
    start = Math.max(2, total - maxButtons + 3);
  }

  const pages: Array<number | '...'> = [1];
  if (start > 2) pages.push('...');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < total - 1) pages.push('...');
  pages.push(total);
  return pages;
}

export function Pagination({
  page,
  pageCount,
  onPage,
  maxButtons = 7,
  className,
}: PaginationProps) {
  const range = pageCount > 0 ? getPageRange(page, pageCount, maxButtons) : [];

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex items-center gap-1', className)}
    >
      {/* Previous */}
      <IconButton
        aria-label="Previous page"
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      </IconButton>

      {/* Page buttons */}
      {range.map((item, i) =>
        item === '...' ? (
          <span
            key={`ellipsis-${i}`}
            className="flex h-8 w-8 items-center justify-center text-sm text-muted-foreground select-none"
            aria-hidden="true"
          >
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            onClick={() => onPage(item)}
            aria-label={`Page ${item}`}
            aria-current={item === page ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 w-8 items-center justify-center rounded-md text-sm font-medium transition-colors duration-fast',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--ring]',
              'disabled:pointer-events-none disabled:opacity-50',
              item === page
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'text-foreground hover:bg-surface-muted',
            )}
          >
            {item}
          </button>
        ),
      )}

      {/* Next */}
      <IconButton
        aria-label="Next page"
        variant="ghost"
        size="sm"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </IconButton>
    </nav>
  );
}
