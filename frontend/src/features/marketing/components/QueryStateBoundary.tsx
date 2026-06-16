import type { ReactNode } from 'react';

interface QueryStateBoundaryProps {
  isLoading: boolean;
  isError: boolean;
  onRetry?: () => void;
  loadingText?: string;
  errorText?: string;
  children: ReactNode;
}

/**
 * Inline guard for a React Query result: renders a loading line while the
 * primary query is in flight, an error block (with an optional Retry button)
 * when it fails, and otherwise the children. The inline complement to the
 * global QueryCache.onError toast — it keeps a failed fetch from rendering as
 * an empty table or a blank panel.
 */
export default function QueryStateBoundary({
  isLoading,
  isError,
  onRetry,
  loadingText = 'Loading…',
  errorText = 'Something went wrong while loading this data.',
  children,
}: QueryStateBoundaryProps) {
  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{loadingText}</p>;
  }

  if (isError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-center">
        <p className="text-sm text-red-700">{errorText}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-3 px-3 py-1.5 text-sm font-medium text-red-700 bg-surface border border-red-300 rounded-lg hover:bg-red-100"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return <>{children}</>;
}
