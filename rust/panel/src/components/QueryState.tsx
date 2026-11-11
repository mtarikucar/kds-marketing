import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Callout, QueryStateBoundary } from '@/components/ui';
import { isApiError } from '@/api/client';
import { errorMessage } from '@/lib/errors';

/**
 * A gate the person can open is a next step, not a failure: retrying cannot help, the strategy
 * page or the billing page can.
 */
const GATES = {
  STRATEGY_REQUIRED: { body: 'gates.strategyBody', link: 'gates.strategyLink', to: '/strategy' },
  WORKSPACE_INACTIVE: { body: 'gates.inactiveBody', link: 'gates.inactiveLink', to: '/billing' },
} as const;
type Gate = (typeof GATES)[keyof typeof GATES];

/**
 * The kit's QueryStateBoundary with the panel's copy for errors and retry. With `keepOnError`, a
 * query that already holds its data keeps showing it when a later read fails (a refresh during an
 * outage), with a line that it could not be read again, rather than swapping it for the error: an
 * open row stays open. The content keeps its place in the tree either way, so nothing below it is
 * mounted again when the line comes or goes.
 */
export function QueryState({
  query,
  children,
  keepOnError = false,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown; data?: unknown };
  children?: ReactNode;
  keepOnError?: boolean;
}) {
  const { t } = useTranslation();
  const kept = keepOnError && query.isError && query.data !== undefined;
  const gate: Gate | undefined =
    query.isError && !kept && isApiError(query.error) ? (GATES as Record<string, Gate>)[query.error.code] : undefined;
  if (gate) {
    return (
      <Callout tone="info">
        <p>{t(gate.body)}</p>
        <Link className="mt-1 inline-block text-primary underline" to={gate.to}>
          {t(gate.link)}
        </Link>
      </Callout>
    );
  }
  return (
    <QueryStateBoundary
      isLoading={query.isLoading}
      isError={query.isError && !kept}
      errorMessage={query.isError ? errorMessage(t, query.error) : undefined}
      retryLabel={t('common.retry')}
      onRetry={() => void query.refetch()}
    >
      {keepOnError ? (
        <>
          {kept ? (
            <p role="status" className="text-caption text-warning">
              {t('common.refreshFailed')}{' '}
              <button type="button" className="underline" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </button>
            </p>
          ) : null}
          {children}
        </>
      ) : (
        children
      )}
    </QueryStateBoundary>
  );
}
