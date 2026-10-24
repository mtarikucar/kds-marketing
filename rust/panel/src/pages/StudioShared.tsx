import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/auth/useSession';
import { isApiError } from '@/api/client';
import type tr from '@/i18n/tr.json';
export type StudioKey = keyof typeof tr.studio;
export const inputClass =
  'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
export const buttonClass =
  'rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
export function useStudioKey() {
  const session = useSession();
  return ['studio', session.data?.current_workspace] as const;
}
export function useStudioMutation<T = void>(
  fn: (value: T) => Promise<unknown>,
  onSuccess?: () => void,
) {
  const client = useQueryClient();
  const key = useStudioKey();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      onSuccess?.();
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: ['work'] }),
        client.invalidateQueries({ queryKey: ['strategy'] }),
      ]);
    },
  });
}
export function Region({
  name,
  children,
  className = '',
}: {
  name: 'strategy' | 'plan' | 'today' | 'learned' | 'ledger';
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby={`studio-${name}`}
      className={`min-w-0 space-y-4 rounded-lg border border-border bg-surface p-4 sm:p-5 ${className}`}
    >
      <h2 id={`studio-${name}`} className="text-lg font-semibold tracking-tight">
        {t(`studio.${name}`)}
      </h2>
      {children}
    </section>
  );
}
export function Field({ label, children }: { label: StudioKey; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{t(`studio.${label}`)}</span>
      {children}
    </label>
  );
}
export function StudioError({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const code = isApiError(error) ? error.code : '';
  const reason = isApiError(error) ? String(error.details.reason ?? error.message) : '';
  const key: StudioKey =
    code === 'STRATEGY_REQUIRED'
      ? 'noStrategy'
      : code === 'BUDGET_CAP'
        ? 'cap'
        : code === 'WORKSPACE_INACTIVE'
          ? 'inactive'
          : code === 'FORBIDDEN'
            ? 'forbidden'
            : /expired|reconnect|unsupported|connector|capability/.test(reason)
              ? 'connectorUnavailable'
              : /brake/.test(reason)
                ? 'braked'
                : code === 'CONFLICT'
                  ? 'stale'
                  : 'failed';
  return (
    <div role="alert" className="space-y-2 rounded-md bg-danger-subtle p-3 text-sm">
      <p>{t(`studio.${key}`)}</p>
      {key === 'noStrategy' ? (
        <Link className="underline" to="/strategy">
          {t('studio.openStrategy')}
        </Link>
      ) : key === 'connectorUnavailable' ? (
        <Link className="underline" to="/capabilities">
          {t('studio.reconnect')}
        </Link>
      ) : null}
    </div>
  );
}
export function Reason({ reason }: { reason: string }) {
  const { t } = useTranslation();
  const key: StudioKey =
    reason === 'human_approval_required'
      ? 'waitingApproval'
      : reason === 'publish_unknown'
        ? 'unknown'
        : /brake/.test(reason)
          ? 'braked'
          : /budget_cap|BUDGET_CAP/.test(reason)
            ? 'cap'
            : /auth|permission|expired|reconnect|capability|connector/.test(reason)
              ? 'connectorUnavailable'
              : /retir/.test(reason)
                ? 'retirement'
                : 'failed';
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p className="font-medium">{t(`studio.${key}`)}</p>
      {key === 'unknown' && <p>{t('studio.unknownHelp')}</p>}
      {key === 'connectorUnavailable' && (
        <Link to="/capabilities" className="underline">
          {t('studio.reconnect')}
        </Link>
      )}
    </div>
  );
}
