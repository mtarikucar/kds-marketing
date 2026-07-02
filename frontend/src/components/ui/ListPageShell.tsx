import type { ReactNode } from 'react';
import { cn } from './cn';
import { PageHeader } from './PageHeader';
import { QueryStateBoundary } from './QueryStateBoundary';

export interface ListPageShellProps {
  title: string;
  description?: string;
  /** Right-aligned header actions (e.g. a "New …" button). */
  actions?: ReactNode;
  /** Optional filter/search row rendered under the header, above the boundary. */
  filters?: ReactNode;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  errorMessage?: string;
  /** When true, `emptyState` is shown in place of `children`. */
  isEmpty?: boolean;
  emptyState?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/**
 * Scaffold for a list/index page: a consistent PageHeader + optional filter row +
 * a standard loading/error(+retry)/empty treatment (via QueryStateBoundary), so
 * list screens stop hand-rolling their own header/loading/error/empty each time.
 * The page supplies its own list body as `children`.
 */
export function ListPageShell({
  title,
  description,
  actions,
  filters,
  isLoading,
  isError,
  onRetry,
  errorMessage,
  isEmpty,
  emptyState,
  children,
  className,
}: ListPageShellProps) {
  return (
    <div className={cn('space-y-4', className)}>
      <PageHeader title={title} description={description} actions={actions} />
      {filters}
      <QueryStateBoundary
        isLoading={isLoading}
        isError={isError}
        onRetry={onRetry}
        errorMessage={errorMessage}
      >
        {isEmpty ? (emptyState ?? null) : children}
      </QueryStateBoundary>
    </div>
  );
}
