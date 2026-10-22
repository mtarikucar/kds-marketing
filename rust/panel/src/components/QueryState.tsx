import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { QueryStateBoundary } from '@/components/ui';
import { errorMessage } from '@/lib/errors';

/** The kit's QueryStateBoundary with the panel's copy for errors and retry. */
export function QueryState({
  query,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <QueryStateBoundary
      isLoading={query.isLoading}
      isError={query.isError}
      errorMessage={query.isError ? errorMessage(t, query.error) : undefined}
      retryLabel={t('common.retry')}
      onRetry={() => void query.refetch()}
    >
      {children}
    </QueryStateBoundary>
  );
}
