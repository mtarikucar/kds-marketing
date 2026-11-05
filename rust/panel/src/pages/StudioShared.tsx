import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/auth/useSession';
import { isApiError } from '@/api/client';
import type tr from '@/i18n/tr.json';
/** A Studio label: a `studio.*` key whose value is a sentence (not a nested group). */
export type StudioKey = {
  [K in keyof typeof tr.studio]: (typeof tr.studio)[K] extends string ? K : never;
}[keyof typeof tr.studio];
export const inputClass =
  'w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
export const buttonClass =
  'min-h-10 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-muted aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
/** Translate standard content formats while retaining names defined by the workspace. */
export function contentTypeLabel(t: TFunction, value: string): string {
  switch (value) {
    case 'text':
    case 'image':
    case 'video':
      return t(`studio.contentFormats.${value}`);
    case 'story':
    case 'feed_post':
    case 'carousel':
    case 'reel':
    case 'tiktok_video':
      return t(`posts.format.${value}`);
    default:
      return value;
  }
}

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
      className={`min-w-0 space-y-4 ${name === 'today' ? 'rounded-xl border border-border bg-surface p-5 sm:p-6' : 'border-t border-border pt-5'} ${className}`}
    >
      <h2 id={`studio-${name}`} className="text-lg font-semibold tracking-tight">
        {t(`studio.${name}`)}
      </h2>
      {children}
    </section>
  );
}
export function Field({ label, children }: { label: StudioKey | 'filters.hypothesis' | 'filters.from' | 'filters.until'; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span>{t(`studio.${label}`)}</span>
      {children}
    </label>
  );
}
export function StudioError({ error, onRetry }: { error: unknown; onRetry?: () => unknown }) {
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
      {onRetry && <button type="button" className={buttonClass} onClick={() => void onRetry()}>{t('common.retry')}</button>}
    </div>
  );
}

export function StudioReadStatus({ query }: { query: { isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  const { t } = useTranslation();
  return query.isLoading
    ? <p role="status" className="py-4 text-sm text-muted-foreground">{t('common.loading')}</p>
    : <StudioError error={query.error} onRetry={query.refetch} />;
}
export function Reason({ reason }: { reason: string }) {
  const { t } = useTranslation();
  const key: StudioKey =
    reason === 'human_approval_required'
      ? 'waitingApproval'
      : reason === 'publish_processing'
        ? 'processing'
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
