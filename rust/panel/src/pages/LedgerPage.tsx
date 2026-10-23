import { Fragment, useId, useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LEDGER_PAGE_SIZE, listLedger } from '@/api/ledger';
import type { LedgerEntryOut } from '@/api/types';
import { QueryState } from '@/components/QueryState';
import { ActorBadge } from '@/components/StatusBadges';
import {
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@/components/ui';
import { formatDateTime } from '@/lib/format';

const COLUMN_COUNT = 5;

function LedgerRow({ item }: { item: LedgerEntryOut }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const payloadId = useId();
  const { entry } = item;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Fragment>
      <TR>
        <TD className="whitespace-nowrap text-muted-foreground">{formatDateTime(entry.at, i18n.language)}</TD>
        <TD>
          <span className="flex flex-wrap items-center gap-1.5">
            <ActorBadge kind={entry.actor.kind} />
            {entry.actor.kind === 'system' && (
              <span className="font-mono text-micro text-muted-foreground">{entry.actor.component}</span>
            )}
          </span>
        </TD>
        <TD>
          <span className="font-mono text-caption text-foreground">{entry.action}</span>
        </TD>
        <TD>
          {entry.subject ? (
            <span className="font-mono text-micro text-muted-foreground">
              {entry.subject.kind} · {entry.subject.id}
            </span>
          ) : (
            <span className="text-muted-foreground">{t('common.none')}</span>
          )}
        </TD>
        <TD className="text-end">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={payloadId}
            onClick={() => setOpen((v) => !v)}
          >
            {t('ledger.payload')}
            <Chevron className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </TD>
      </TR>
      {open && (
        <TR id={payloadId} className="bg-surface-muted/50 hover:bg-surface-muted/50">
          <TD colSpan={COLUMN_COUNT}>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface p-3 font-mono text-micro text-foreground">
              {JSON.stringify(entry.payload, null, 2)}
            </pre>
            <p className="mt-1.5 text-micro text-muted-foreground">{t('ledger.redactedNote')}</p>
          </TD>
        </TR>
      )}
    </Fragment>
  );
}

export function LedgerPage() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [prefix, setPrefix] = useState('');

  const ledger = useInfiniteQuery({
    queryKey: ['ledger', prefix],
    queryFn: ({ pageParam }) =>
      listLedger({ action_prefix: prefix || undefined, before_id: pageParam, limit: LEDGER_PAGE_SIZE }),
    initialPageParam: undefined as number | undefined,
    // A full page may have more behind it; the next page starts below its last (oldest) id.
    getNextPageParam: (last) => (last.length === LEDGER_PAGE_SIZE ? last[last.length - 1].id : undefined),
  });

  const entries = ledger.data?.pages.flat() ?? [];

  const onFilter = (e: FormEvent) => {
    e.preventDefault();
    setPrefix(draft.trim());
  };
  const onClear = () => {
    setDraft('');
    setPrefix('');
  };

  return (
    <>
      <PageHeader title={t('ledger.title')} description={t('ledger.description')} />
      <form className="flex flex-wrap items-end gap-2" onSubmit={onFilter} role="search">
        <Field label={t('ledger.filter')} className="w-full max-w-xs">
          {(ids) => (
            <Input
              id={ids.id}
              value={draft}
              placeholder={t('ledger.filterPlaceholder')}
              className="font-mono"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setDraft(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="secondary">
          {t('ledger.apply')}
        </Button>
        {prefix && (
          <Button type="button" variant="ghost" onClick={onClear}>
            {t('ledger.clear')}
          </Button>
        )}
      </form>
      <QueryState query={ledger}>
        {entries.length === 0 ? (
          <EmptyState title={t('ledger.empty')} description={t('ledger.emptyBody')} />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-xl border border-border bg-surface">
              <Table>
                <THead>
                  <TR>
                    <TH>{t('ledger.columns.at')}</TH>
                    <TH>{t('ledger.columns.actor')}</TH>
                    <TH>{t('ledger.columns.action')}</TH>
                    <TH>{t('ledger.columns.subject')}</TH>
                    <TH className="text-end">
                      <span className="sr-only">{t('ledger.columns.payload')}</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {entries.map((item) => (
                    <LedgerRow key={item.id} item={item} />
                  ))}
                </TBody>
              </Table>
            </div>
            {ledger.hasNextPage && (
              <Button
                variant="outline"
                className="self-center"
                onClick={() => void ledger.fetchNextPage()}
                loading={ledger.isFetchingNextPage}
              >
                {t('ledger.loadMore')}
              </Button>
            )}
          </div>
        )}
      </QueryState>
    </>
  );
}
