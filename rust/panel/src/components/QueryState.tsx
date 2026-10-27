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

/** The kit's QueryStateBoundary with the panel's copy for errors and retry. */
export function QueryState({
  query,
  children,
}: {
  query: { isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const gate: Gate | undefined =
    query.isError && isApiError(query.error) ? (GATES as Record<string, Gate>)[query.error.code] : undefined;
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
      isError={query.isError}
      errorMessage={query.isError ? errorMessage(t, query.error) : undefined}
      retryLabel={t('common.retry')}
      onRetry={() => void query.refetch()}
    >
      {children}
    </QueryStateBoundary>
  );
}
