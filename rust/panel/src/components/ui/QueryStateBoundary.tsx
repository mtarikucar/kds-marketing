import type { ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './Spinner';
import { Button } from './Button';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';

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
  const { t } = useTranslation();
  if (isError) {
    return (
      <div className={cn('flex min-w-0 flex-col items-start gap-3 rounded-lg border border-border bg-surface p-5', className)} role="alert">
        <div className="flex min-w-0 items-start gap-3">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
          <p className="break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]">{errorMessage}</p>
        </div>
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
            <div className={cn('flex items-center justify-center gap-3 py-12 text-muted-foreground', className)}>
          <Spinner />
              <span className="text-sm" aria-hidden="true">{t('kit.loading')}</span>
        </div>
      )
    );
  }
  return <>{children ?? null}</>;
}
