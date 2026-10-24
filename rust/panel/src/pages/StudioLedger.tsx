import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { Region, StudioError, buttonClass, useStudioKey } from './StudioShared';
export function StudioLedger({ query, allowed }: { query: api.Query; allowed: boolean }) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  const rows = useInfiniteQuery({
    queryKey: [...key, 'ledger', query],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.ledger({ ...query, limit: 50, before: pageParam }),
    getNextPageParam: (page) => page.next_before ?? undefined,
    enabled: allowed,
  });
  const download = useMutation({
    mutationFn: () => api.ledgerExport({ ...query, limit: 500 }),
    onSuccess: (out) => {
      const url = URL.createObjectURL(new Blob([out.content], { type: out.media_type }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = out.filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  });
  const entries = rows.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <Region name="ledger" className="lg:col-span-3">
      <button
        className={buttonClass}
        disabled={!allowed || download.isPending}
        onClick={() => download.mutate()}
      >
        {t('studio.export')}
      </button>
      <StudioError error={rows.error || download.error} />
      <ol className="divide-y divide-border">
        {entries.map(({ id, entry: e }) => (
          <li key={id} className="grid gap-2 py-3 text-sm sm:grid-cols-[10rem_1fr]">
            <div>
              <time dateTime={e.at}>{new Date(e.at).toLocaleString(i18n.language)}</time>
              <p className="text-xs text-muted-foreground">
                {t(`studio.${e.actor.kind}`)}:{' '}
                {'user_id' in e.actor ? e.actor.user_id : e.actor.component}
                {'connection_id' in e.actor && ` / ${e.actor.connection_id}`}
              </p>
            </div>
            <div className="min-w-0 space-y-1 break-words">
              <p className="font-medium">{e.action}</p>
              <p>
                {t('studio.target')}: {e.subject?.id ?? '—'} · {t('studio.version')}:{' '}
                {e.strategy_version_id ?? '—'}
              </p>
              <details>
                <summary className="cursor-pointer">{t('studio.evidence')}</summary>
                <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-surface-muted p-2 text-xs">
                  {JSON.stringify(e.payload, null, 2)}
                </pre>
              </details>
            </div>
          </li>
        ))}
      </ol>
      {!entries.length && (
        <p className="text-sm text-muted-foreground">{t('studio.emptyLedger')}</p>
      )}
      {rows.hasNextPage && (
        <button
          className={buttonClass}
          disabled={rows.isFetchingNextPage}
          onClick={() => void rows.fetchNextPage()}
        >
          {t('studio.more')}
        </button>
      )}
    </Region>
  );
}
