import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { listAgents } from '@/api/agents';
import { decideProspect, doNotContact } from '@/api/prospects';
import { listTeam } from '@/api/team';
import {
  DNC_REASONS,
  REJECT_REASONS,
  type DncReason,
  type ProspectStatus,
  type Recorder,
  type RejectReason,
  type SourceRef,
} from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { useInFlight, webUrl } from '@/lib/leads';
import { selectClass } from './InboxShared';

// What the leads pages share (spec 2026-10-30-leads-pool-outreach-design.md §9): query keys,
// badges, how a source and a recorder are shown, and the reject and do-not-contact dialogs the
// pool's rows, its bulk bar and a prospect's page all use.

/** Every leads query of the current workspace starts with this. */
export function useLeadsKey() {
  const session = useSession();
  return ['leads', session.data?.current_workspace] as const;
}

/** Reads every leads query (and the home's pending work) again after a change. */
export function useLeadsRefresh() {
  const client = useQueryClient();
  const key = useLeadsKey();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: key }),
      client.invalidateQueries({ queryKey: ['work', 'pending'] }),
    ]);
}

const STATUS_TONE: Record<ProspectStatus, 'info' | 'success' | 'neutral' | 'primary' | 'danger'> = {
  new: 'info',
  qualified: 'success',
  rejected: 'neutral',
  promoted: 'primary',
  do_not_contact: 'danger',
};

export function ProspectStatusBadge({ status }: { status: ProspectStatus }) {
  const { t } = useTranslation();
  return <Badge tone={STATUS_TONE[status]}>{t(`leads.status.${status}`)}</Badge>;
}

/**
 * Where a value was seen. A web address opens in a new tab that gets no hold on the panel
 * (`noopener noreferrer`); anything else, a `javascript:` address included, is only text.
 */
export function SourceView({ source }: { source: SourceRef }) {
  const { t } = useTranslation();
  if (source.kind === 'url') {
    const href = webUrl(source.url);
    return (
      <span className="break-all">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
            {source.url}
          </a>
        ) : (
          <span className="text-muted-foreground">{source.url}</span>
        )}
        {source.note && <span className="text-muted-foreground"> · {source.note}</span>}
      </span>
    );
  }
  if (source.kind === 'manual') return <span>{t('leads.source.manual', { note: source.note })}</span>;
  return <span>{t('leads.source.import', { system: source.system })}</span>;
}

/** The names a recorder is shown by: agent connections and members of the workspace. */
export function useLeadsNames() {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const agents = useQuery({ queryKey: [...key, 'agents'], queryFn: listAgents });
  const team = useQuery({ queryKey: [...key, 'team'], queryFn: listTeam });
  return {
    member(userId: string): string {
      const m = team.data?.find((x) => x.user_id === userId);
      return m?.display_name || m?.email || t('leads.recorder.member');
    },
    agent(connectionId: string): string {
      return agents.data?.find((a) => a.id === connectionId)?.client_name ?? t('leads.recorder.agent');
    },
  };
}

export type LeadsNames = ReturnType<typeof useLeadsNames>;

/** Who recorded a value: the agent connection (and for whom), the member, the importer or a job. */
export function recorderText(t: TFunction, names: LeadsNames, r: Recorder): string {
  switch (r.kind) {
    case 'agent':
      return t('leads.recorder.agentNamed', { name: names.agent(r.connection_id), member: names.member(r.user_id) });
    case 'human':
      return names.member(r.user_id);
    case 'import':
      return t('leads.recorder.import', { system: r.system });
    case 'system':
      return t('leads.recorder.system', { job: r.job });
  }
}

/** A prospect a decision is about, at the revision shown. */
export interface DecisionTarget {
  id: string;
  business_name: string;
  revision: number;
}

/** What became of one prospect of a bulk action. */
export interface BulkOutcome {
  id: string;
  name: string;
  ok: boolean;
  text: string;
}

/**
 * Runs `act` for one target, or for each of several in turn. One target's refusal is thrown (its
 * dialog stays open and says why); with several, each refusal is an outcome and never stops the
 * rest.
 */
async function forTargets(
  t: TFunction,
  targets: DecisionTarget[],
  act: (target: DecisionTarget) => Promise<unknown>,
  okText: string,
): Promise<BulkOutcome[]> {
  if (targets.length === 1) {
    await act(targets[0]);
    return [{ id: targets[0].id, name: targets[0].business_name, ok: true, text: okText }];
  }
  const out: BulkOutcome[] = [];
  for (const target of targets) {
    try {
      await act(target);
      out.push({ id: target.id, name: target.business_name, ok: true, text: okText });
    } catch (err) {
      out.push({ id: target.id, name: target.business_name, ok: false, text: errorMessage(t, err) });
    }
  }
  return out;
}

/** The rejection of one or more prospects: a reason is required, and a note for `other`. */
export function RejectDialog({
  targets,
  onClose,
  onDone,
}: {
  targets: DecisionTarget[];
  onClose: () => void;
  onDone: (outcomes: BulkOutcome[]) => void;
}) {
  const { t } = useTranslation();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const [reason, setReason] = useState<RejectReason | ''>('');
  const [note, setNote] = useState('');
  const reject = useMutation({
    mutationFn: (r: RejectReason) =>
      forTargets(
        t,
        targets,
        (target) =>
          decideProspect(target.id, {
            decision: 'reject',
            reason: r,
            note: note.trim() || undefined,
            expected_revision: target.revision,
          }),
        t('leads.outcome.rejected'),
      ),
    onSuccess: async (outcomes) => {
      await refresh();
      onDone(outcomes);
    },
  });
  const valid = reason !== '' && (reason !== 'other' || note.trim() !== '') && [...note].length <= 500;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => reject.mutate(reason, { onSettled: release }));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !reject.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('leads.reject.title')}</DialogTitle>
          <DialogDescription>
            {targets.length === 1 ? targets[0].business_name : t('leads.reject.many', { n: targets.length })}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit} aria-label={t('leads.reject.title')}>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.reject.reason')}
            <select className={selectClass} value={reason} onChange={(e) => setReason(e.target.value as RejectReason | '')}>
              <option value="">{t('leads.reject.choose')}</option>
              {REJECT_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`leads.rejectReasons.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {reason === 'other' ? t('leads.reject.noteRequired') : t('leads.reject.note')}
            <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <ErrorCallout error={reject.error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={reject.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!valid} loading={reject.isPending}>
              {t('leads.reject.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A do-not-contact mark for one or more prospects: a reason, and the phrase typed to confirm it
 * (it scrubs the prospect and blocks its keys for good).
 */
export function DncDialog({
  targets,
  onClose,
  onDone,
}: {
  targets: DecisionTarget[];
  onClose: () => void;
  onDone: (outcomes: BulkOutcome[]) => void;
}) {
  const { t } = useTranslation();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const [reason, setReason] = useState<DncReason | ''>('');
  const [note, setNote] = useState('');
  const [phrase, setPhrase] = useState('');
  const block = useMutation({
    mutationFn: (r: DncReason) =>
      forTargets(
        t,
        targets,
        (target) => doNotContact({ confirm: true, prospect_id: target.id, reason: r, note: note.trim() || undefined }),
        t('leads.outcome.blocked'),
      ),
    onSuccess: async (outcomes) => {
      await refresh();
      onDone(outcomes);
    },
  });
  const valid = reason !== '' && phrase.trim() === t('leads.dnc.phrase') && [...note].length <= 500;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => block.mutate(reason, { onSettled: release }));
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !block.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('leads.dnc.title')}</DialogTitle>
          <DialogDescription>{t('leads.dnc.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit} aria-label={t('leads.dnc.title')}>
          <p className="text-sm font-medium">
            {targets.length === 1 ? targets[0].business_name : t('leads.dnc.many', { n: targets.length })}
          </p>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.dnc.reason')}
            <select className={selectClass} value={reason} onChange={(e) => setReason(e.target.value as DncReason | '')}>
              <option value="">{t('leads.dnc.choose')}</option>
              {DNC_REASONS.map((r) => (
                <option key={r} value={r}>
                  {t(`leads.dncReasons.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.dnc.note')}
            <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.dnc.confirm', { phrase: t('leads.dnc.phrase') })}
            <Input autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </label>
          <ErrorCallout error={block.error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={block.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={!valid} loading={block.isPending}>
              {t('leads.dnc.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The outcome of a bulk action, one line per prospect. */
export function BulkOutcomes({ outcomes, onDismiss }: { outcomes: BulkOutcome[]; onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label={t('leads.bulk.results')}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{t('leads.bulk.results')}</h2>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t('leads.bulk.dismiss')}
        </Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm" aria-label={t('leads.bulk.results')}>
        {outcomes.map((o) => (
          <li key={o.id} data-ok={o.ok ? 'true' : 'false'} className="flex flex-wrap gap-2">
            <span className="font-medium">{o.name}</span>
            <span className={o.ok ? 'text-success' : 'text-danger'}>{o.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
