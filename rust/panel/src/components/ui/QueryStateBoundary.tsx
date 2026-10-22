import type { ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './Spinner';
import { Button } from './Button';

export interface QueryStateBoundaryProps {
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  errorMessage?: string;
  retryLabel?: string;
  /** Custom loading node (defaults to a centered spinner). */
  loading?: ReactNode;
  className?: string;
  /** Rendered when not loading and not errored. Optional so the boundary can
   *  also be used as a bare state indicator that renders nothing on success. */
  children?: ReactNode;
}

/**
 * One standard place for a query's loading + error(+retry) states, so every list
 * screen shows the same "it's loading" / "it failed, retry" treatment instead of
 * each page hand-rolling a spinner or a bare error line. Renders `children` when
 * the query is settled and healthy.
 */
export function QueryStateBoundary({
  isLoading,
  isError,
  onRetry,
  errorMessage = 'Could not load. Please try again.',
  retryLabel = 'Retry',
  loading,
  className,
  children,
}: QueryStateBoundaryProps) {
  if (isError) {
    return (
      <div className={cn('flex flex-col items-center gap-3 py-10', className)} role="alert">
        <p className="text-sm text-danger">{errorMessage}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
      </div>
    );
  }
  if (isLoading) {
    return (
      loading ?? (
        <div className={cn('flex justify-center py-16', className)}>
          <Spinner />
        </div>
      )
    );
  }
  return <>{children ?? null}</>;
}
