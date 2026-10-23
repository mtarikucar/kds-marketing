import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/inbox';
import type { InboxMerge } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { can } from '@/lib/roles';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  PageHeader,
} from '@/components/ui';
import { selectClass, useInboxKey, useInboxMutation } from './InboxShared';

function MergeCard({ row }: { row: InboxMerge }) {
  const { t } = useTranslation();
  const key = useInboxKey();
  const [keep, setKeep] = useState(row.target_id);
  const [undoOpen, setUndoOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const source = useQuery({
    queryKey: [...key, 'person', row.source_id],
    queryFn: () => api.getPerson(row.source_id),
  });
  const target = useQuery({
    queryKey: [...key, 'person', row.target_id],
    queryFn: () => api.getPerson(row.target_id),
  });
  const apply = useInboxMutation(() => api.applyMerge(row.id, keep));
  const refuse = useInboxMutation(() => api.refuseMerge(row.id));
  const undo = useInboxMutation(
    () => api.undoMerge(row.id),
    () => {
      setUndoOpen(false);
      setConfirmation('');
    },
  );
  const busy = apply.isPending || refuse.isPending || undo.isPending;
  const sourceName = source.data?.person.display_name || row.source_id;
  const targetName = target.data?.person.display_name || row.target_id;
  return (
    <article
      id={`merge-${row.id}`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-muted p-3 text-sm [overflow-wrap:anywhere]"
    >
      <h3 className="font-semibold">{t('inbox.merges.suggestion')}</h3>
      <p>
        {sourceName} / {targetName}
      </p>
      <Badge className="self-start">
        {t(`inbox.merges.status.${row.status}`, { defaultValue: row.status })}
      </Badge>
      <ul className="list-inside list-disc">
        {row.conflicts.map((conflict) => (
          <li key={conflict}>{t(`inbox.merges.conflict.${conflict}`)}</li>
        ))}
      </ul>
      {row.status === 'suggested' && (
        <>
          <label>
            {t('inbox.merges.keep')}
            <select className={selectClass} value={keep} onChange={(e) => setKeep(e.target.value)}>
              <option value={row.target_id}>{targetName}</option>
              <option value={row.source_id}>{sourceName}</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => apply.mutate()}>
              {t('inbox.merges.apply')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => refuse.mutate()}>
              {t('inbox.merges.refuse')}
            </Button>
          </div>
        </>
      )}
      {row.status === 'applied' && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setUndoOpen(true);
            setConfirmation('');
          }}
        >
          {t('inbox.merges.undo')}
        </Button>
      )}
      <ErrorCallout error={apply.error || refuse.error} />
      <Dialog
        open={undoOpen}
        onOpenChange={(open) => {
          if (!undo.isPending) setUndoOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('inbox.merges.undo')}</DialogTitle>
            <DialogDescription>
              {t('inbox.merges.confirmHint', { phrase: t('inbox.merges.confirmPhrase') })}
            </DialogDescription>
          </DialogHeader>
          <label className="text-sm">
            {t('inbox.merges.confirmLabel')}
            <Input
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
            />
          </label>
          <ErrorCallout error={undo.error} />
          <DialogFooter>
            <Button variant="outline" disabled={undo.isPending} onClick={() => setUndoOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              loading={undo.isPending}
              disabled={confirmation !== t('inbox.merges.confirmPhrase')}
              onClick={() => {
                if (confirmation === t('inbox.merges.confirmPhrase')) undo.mutate();
              }}
            >
              {t('inbox.merges.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}

export function InboxMergeBanner({ personId }: { personId: string }) {
  const key = useInboxKey();
  const session = useSession();
  const allowed = can(session.data, 'inbox.manage');
  const merges = useQuery({ queryKey: [...key, 'merges'], queryFn: api.listMerges, enabled: allowed });
  if (!allowed) return null;
  return (
    <QueryState query={merges}>
      {merges.data
        ?.filter(
          (row) =>
            (row.source_id === personId || row.target_id === personId) &&
            ['suggested', 'applied'].includes(row.status),
        )
        .map((row) => (
          <MergeCard key={row.id} row={row} />
        ))}
    </QueryState>
  );
}

export function InboxMerges() {
  const { t } = useTranslation();
  const key = useInboxKey();
  const session = useSession();
  const allowed = can(session.data, 'inbox.manage');
  const [params] = useSearchParams();
  const selected = params.get('merge');
  const merges = useQuery({ queryKey: [...key, 'merges'], queryFn: api.listMerges, enabled: allowed });
  if (session.isPending) return <QueryState query={session} />;
  if (!allowed)
    return (
      <Callout tone="warning">
        {t('errors.missingPermission', { permission: t('permissions.inbox.manage') })}
      </Callout>
    );
  const rows = merges.data?.filter((row) => !selected || row.id === selected);
  return (
    <>
      <PageHeader
        title={t('inbox.merges.title')}
        actions={
          <Button asChild variant="outline">
            <Link to="/inbox">{t('inbox.title')}</Link>
          </Button>
        }
      />
      <QueryState query={merges}>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {rows?.map((row) => (
            <MergeCard key={row.id} row={row} />
          ))}
        </div>
        {rows?.length === 0 && <p className="text-muted-foreground">{t('inbox.merges.empty')}</p>}
      </QueryState>
    </>
  );
}
