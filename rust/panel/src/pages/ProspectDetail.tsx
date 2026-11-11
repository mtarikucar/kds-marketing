import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import {
  AtSign,
  Building2,
  Check,
  ChevronLeft,
  Globe,
  Instagram,
  Mail,
  MapPin,
  MoreHorizontal,
  Pencil,
  Phone,
  Plus,
  Send,
  User,
  type LucideIcon,
} from 'lucide-react';
import { addNote, getJourney, getPerson } from '@/api/inbox';
import { decideProspect, eraseProspect, getPlaybook, getProspect, updateProspect } from '@/api/prospects';
import type { ContactPerson, InboxJourneyOut, Prospect, ProspectField, ProspectGetOut, SizeHint } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  Input,
  Textarea,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney, formatWhen } from '@/lib/format';
import { useInFlight } from '@/lib/leads';
import { can } from '@/lib/roles';
import {
  DncDialog,
  ProspectStatusBadge,
  RejectDialog,
  SourceView,
  recorderText,
  useLeadsKey,
  useLeadsNames,
  useLeadsRefresh,
  type BulkOutcome,
} from './LeadsShared';
import { usePoolCopy, type PoolCopyKey } from './prospects/copy';
import { MessageDialog } from './prospects/MessageDialog';
import { buildTimeline, stageOf, type StepKey, type TimelineEntry, type TimelineTone } from './prospects/timeline';

type ContactKey = 'phone' | 'email' | 'website' | 'instagram' | 'tiktok' | 'address';
const CONTACT_KEYS: readonly ContactKey[] = ['phone', 'email', 'website', 'instagram', 'tiktok', 'address'];
const CONTACT_ICON: Record<ContactKey | 'contact_person' | 'size', LucideIcon> = {
  phone: Phone,
  email: Mail,
  website: Globe,
  instagram: Instagram,
  tiktok: AtSign,
  address: MapPin,
  contact_person: User,
  size: Building2,
};
/** The longest note the pool keeps (`jt_prospects`). */
const MAX_NOTES = 2000;
/** Timeline entries shown before "show all". */
const TIMELINE_SHOWN = 8;

/** How a size hint reads: branches, an employee band, a note. */
function sizeText(t: TFunction, s: SizeHint): string {
  return [
    s.branches != null ? t('leads.prospect.branches', { n: s.branches }) : null,
    s.employees ? t('leads.prospect.employees', { band: s.employees }) : null,
    s.note || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A side or main card: a small heading over its content. */
function Card({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-2', className)} aria-label={title}>
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/** One contact value with its evidence: the sources, when it was seen, who recorded it. */
function FieldRow<T>({ icon: Icon, label, field, text }: { icon: LucideIcon; label: string; field: ProspectField<T>; text: string }) {
  const { t, i18n } = useTranslation();
  const names = useLeadsNames();
  return (
    <li className="flex gap-2.5 border-b border-border/60 py-2 last:border-b-0" data-testid="prospect-field">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-muted text-muted-foreground" title={label}>
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="sr-only">{label}</span>
          <span className="break-all text-sm font-medium">{text}</span>
          {!field.deliverable && <Badge tone="warning">{t('leads.prospect.undeliverable')}</Badge>}
        </div>
        <ul className="flex flex-col text-xs" aria-label={t('leads.prospect.sourcesOf', { field: label })}>
          {field.evidence.sources.map((s, i) => (
            <li key={i}>
              <SourceView source={s} />
            </li>
          ))}
        </ul>
        <span className="text-xs text-muted-foreground">
          {t('leads.prospect.evidence', {
            at: formatDateTime(field.evidence.captured_at, i18n.language),
            by: recorderText(t, names, field.evidence.recorder),
          })}
        </span>
      </div>
    </li>
  );
}

/** The erasure of a prospect: the typed word (`SİL` / `ERASE`) confirms it. */
function EraseDialog({ prospect, onClose }: { prospect: Prospect; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const [phrase, setPhrase] = useState('');
  const erase = useMutation({
    mutationFn: () => eraseProspect(prospect.id),
    onSuccess: async () => {
      toast.success(t('leads.erase.done'));
      await refresh();
      navigate('/prospects', { replace: true });
    },
  });
  const valid = phrase.trim() === t('leads.erase.phrase');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => erase.mutate(undefined, { onSettled: release }));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !erase.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('leads.erase.title')}</DialogTitle>
          <DialogDescription>{t('leads.erase.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit} aria-label={t('leads.erase.title')}>
          <p className="text-sm font-medium">{prospect.business_name}</p>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.erase.confirm', { phrase: t('leads.erase.phrase') })}
            <Input autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </label>
          <ErrorCallout error={erase.error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={erase.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="destructive" disabled={!valid} loading={erase.isPending}>
              {t('leads.erase.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The actions a prospect's status allows the signed-in person: the frequent ones as buttons, the rest in a menu. */
function Actions({ data, conversationHref }: { data: ProspectGetOut; conversationHref: string | undefined }) {
  const { t } = useTranslation();
  const copy = usePoolCopy();
  const session = useSession();
  const refresh = useLeadsRefresh();
  const p = data.prospect;
  const manage = can(session.data, 'prospects.manage');
  // Writing to a prospect takes it into the inbox, which is the inbox's permission; a new one is
  // qualified by the same act, which is the pool's.
  const canMessage =
    (p.status === 'qualified' || p.status === 'promoted' || p.status === 'new') &&
    can(session.data, 'inbox.work') &&
    (p.status !== 'new' || can(session.data, 'prospects.work'));
  const [dialog, setDialog] = useState<'reject' | 'dnc' | 'erase' | 'message' | null>(null);
  const decide = useMutation({
    mutationFn: (decision: 'qualify' | 'reopen') => decideProspect(p.id, { decision, expected_revision: p.revision }),
    onSuccess: async () => {
      toast.success(t('leads.prospect.saved'));
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const done = (out: BulkOutcome[]) => {
    setDialog(null);
    if (out[0]) toast.success(out[0].text);
  };
  const open = p.status === 'new' || p.status === 'qualified';
  const target = [{ id: p.id, business_name: p.business_name, revision: p.revision }];
  const canReopen = p.status === 'rejected' && manage;
  const canBlock = p.status !== 'promoted' && p.status !== 'do_not_contact';
  const canErase = manage && p.status !== 'promoted';
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {canMessage && (
        <Button size="sm" onClick={() => setDialog('message')}>
          <Send className="h-4 w-4" aria-hidden="true" />
          {copy('sendMessage')}
        </Button>
      )}
      {conversationHref && (
        <Button asChild size="sm" variant="outline">
          <Link to={conversationHref}>{copy('openConversation')}</Link>
        </Button>
      )}
      {p.status === 'new' && (
        <Button size="sm" variant="outline" loading={decide.isPending && decide.variables === 'qualify'} disabled={decide.isPending} onClick={() => decide.mutate('qualify')}>
          {t('leads.actions.qualify')}
        </Button>
      )}
      {open && (
        <Button size="sm" variant="outline" onClick={() => setDialog('reject')}>
          {t('leads.actions.reject')}
        </Button>
      )}
      {(canReopen || canBlock || canErase) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton size="sm" variant="ghost" aria-label={copy('more')}>
              <MoreHorizontal className="h-4 w-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canReopen && (
              <DropdownMenuItem disabled={decide.isPending} onSelect={() => decide.mutate('reopen')}>
                {t('leads.actions.reopen')}
              </DropdownMenuItem>
            )}
            {canBlock && (
              <DropdownMenuItem className="text-danger" onSelect={() => setDialog('dnc')}>
                {t('leads.actions.dnc')}
              </DropdownMenuItem>
            )}
            {canErase && (
              <DropdownMenuItem className="text-danger" onSelect={() => setDialog('erase')}>
                {t('leads.actions.erase')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {dialog === 'reject' && <RejectDialog targets={target} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'dnc' && <DncDialog targets={target} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'erase' && <EraseDialog prospect={p} onClose={() => setDialog(null)} />}
      {dialog === 'message' && <MessageDialog data={data} onClose={() => setDialog(null)} />}
    </div>
  );
}

const STEP_LABEL: Record<StepKey, PoolCopyKey> = {
  found: 'stepFound',
  scored: 'stepScored',
  qualified: 'stepQualified',
  contacted: 'stepContacted',
  replied: 'stepReplied',
  meeting: 'stepMeeting',
  won: 'stepWon',
};

/** Where the prospect stands, as steps; a closed one says why beside them. */
function StageSteps({ data, journey }: { data: ProspectGetOut; journey: InboxJourneyOut | undefined }) {
  const { t } = useTranslation();
  const copy = usePoolCopy();
  const p = data.prospect;
  const stage = stageOf(data, journey);
  const closedText =
    stage.closed === 'lost'
      ? [copy('closedLost'), journey?.journey.lost_reason?.reason_label].filter(Boolean).join(': ')
      : p.decision
        ? ('rejected' in p.decision.kind
            ? t('leads.prospect.rejectedFor', { reason: t(`leads.rejectReasons.${p.decision.kind.rejected}`) })
            : t('leads.prospect.blockedFor', { reason: t(`leads.dncReasons.${p.decision.kind.do_not_contact}`) })) +
          (p.decision.note ? ` · ${p.decision.note}` : '')
        : stage.closed === 'rejected'
          ? copy('closedRejected')
          : stage.closed === 'blocked'
            ? copy('closedBlocked')
            : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface-muted/40 px-4 py-2">
      <ol className={cn('flex min-w-0 flex-1 items-center text-xs', stage.closed && 'opacity-60')} aria-label={copy('steps')}>
        {stage.steps.map(({ key, state }, i) => (
          <li key={key} className="flex min-w-0 flex-1 items-center gap-1.5 last:flex-none" aria-current={state === 'now' ? 'step' : undefined} data-state={state}>
            <span
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-semibold',
                state === 'done' && 'border-success bg-success text-white',
                state === 'now' && 'border-primary bg-primary text-primary-foreground',
                state === 'todo' && 'border-border-strong text-muted-foreground',
              )}
              aria-hidden="true"
            >
              {state === 'done' ? <Check className="h-2.5 w-2.5" /> : i + 1}
            </span>
            <span className={cn('truncate', state === 'done' && 'text-success', state === 'now' && 'font-semibold text-foreground', state === 'todo' && 'text-muted-foreground')}>
              {copy(STEP_LABEL[key])}
              <span className="sr-only"> ({copy(state === 'done' ? 'stepDone' : state === 'now' ? 'stepNow' : 'stepNext')})</span>
            </span>
            {i < stage.steps.length - 1 && <span className="mx-1 h-px min-w-3 flex-1 bg-border" aria-hidden="true" />}
          </li>
        ))}
      </ol>
      {closedText && <p className="text-xs font-medium text-danger">{closedText}</p>}
    </div>
  );
}

/**
 * The prospect's note: the research note and what the team adds, prominent and edited in place
 * while the prospect is still in the pool. Once it is in contact the pool no longer edits it; a
 * new note goes on its journey and shows in the timeline.
 */
function NotesCard({ p }: { p: Prospect }) {
  const { t } = useTranslation();
  const copy = usePoolCopy();
  const session = useSession();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const inPool = p.status === 'new' || p.status === 'qualified' || p.status === 'rejected';
  const canEdit = inPool && can(session.data, 'prospects.work');
  const canAddToJourney = !!p.promoted && can(session.data, 'inbox.work');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.notes);
  const save = useMutation({
    mutationFn: async (text: string): Promise<void> => {
      if (canEdit) {
        await updateProspect(p.id, text ? { expected_revision: p.revision, set: { notes: text } } : { expected_revision: p.revision, clear: ['notes'] });
      } else {
        await addNote(p.promoted!.journey_id, text);
      }
    },
    onSuccess: async () => {
      toast.success(copy('notesSaved'));
      setEditing(false);
      if (!canEdit) setDraft('');
      await refresh();
    },
  });
  const text = draft.trim();
  const valid = [...text].length <= MAX_NOTES && (canEdit ? text !== p.notes.trim() : text !== '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => save.mutate(text, { onSettled: release }));
  };
  const start = () => {
    setDraft(canEdit ? p.notes : '');
    save.reset();
    setEditing(true);
  };
  return (
    <Card
      title={copy('notes')}
      action={
        !editing &&
        (canEdit || canAddToJourney) && (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={start}>
            {canEdit && p.notes ? <Pencil className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            {canEdit && p.notes ? copy('edit') : copy('addNote')}
          </Button>
        )
      }
    >
      {p.notes ? (
        <p className="whitespace-pre-wrap rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm leading-6 dark:border-amber-500/30 dark:bg-amber-500/10" data-testid="prospect-notes">
          {p.notes}
        </p>
      ) : (
        !editing && (
          <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{copy('noNotes')}</span> {canEdit && copy('noNotesBody')}
          </p>
        )
      )}
      {!inPool && p.promoted && !editing && <p className="text-xs text-muted-foreground">{copy('notesLocked')}</p>}
      {editing && (
        <form className="flex flex-col gap-2" onSubmit={submit} aria-label={copy('notes')}>
          <Textarea aria-label={copy('notesField')} autoFocus rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={cn('text-xs', [...text].length > MAX_NOTES ? 'text-danger' : 'text-muted-foreground')}>
              {copy('notesLeft', { n: MAX_NOTES - [...text].length })}
            </span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={save.isPending} onClick={() => setEditing(false)}>
                {copy('cancel')}
              </Button>
              <Button type="submit" size="sm" disabled={!valid} loading={save.isPending}>
                {copy('save')}
              </Button>
            </div>
          </div>
          <ErrorCallout error={save.error} />
        </form>
      )}
      <span className="sr-only" aria-live="polite">{save.isSuccess ? t('leads.prospect.saved') : ''}</span>
    </Card>
  );
}

const TONE_DOT: Record<TimelineTone, string> = {
  human: 'bg-primary',
  system: 'bg-border-strong',
  good: 'bg-success',
  bad: 'bg-danger',
};

/** The prospect's progress: one line an entry, newest first. */
function TimelineCard({ entries }: { entries: TimelineEntry[] }) {
  const { i18n } = useTranslation();
  const copy = usePoolCopy();
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, TIMELINE_SHOWN);
  return (
    <Card title={copy('timeline')}>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy('noTimeline')}</p>
      ) : (
        <ol className="flex flex-col" aria-label={copy('timeline')}>
          {shown.map((entry) => (
            <li key={entry.id} className="grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-start gap-x-2.5 pb-2.5" data-tone={entry.tone}>
              <span className={cn('mt-1.5 h-2 w-2 justify-self-center rounded-full', TONE_DOT[entry.tone])} aria-hidden="true" />
              <div className={cn('min-w-0 text-sm leading-5', entry.tone === 'system' && 'text-muted-foreground')}>
                {entry.href ? (
                  <Link to={entry.href} className="font-medium hover:underline">
                    {entry.title}
                  </Link>
                ) : (
                  <span className={entry.tone === 'system' ? undefined : 'font-medium'}>{entry.title}</span>
                )}
                {entry.detail && <span className="line-clamp-2 block text-xs text-muted-foreground">{entry.detail}</span>}
              </div>
              <time dateTime={entry.at} className="whitespace-nowrap pt-0.5 text-[11px] tabular-nums text-muted-foreground">
                {formatWhen(entry.at, i18n.language)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {entries.length > TIMELINE_SHOWN && (
        <Button size="sm" variant="ghost" className="h-7 self-start px-2 text-xs" onClick={() => setAll((v) => !v)}>
          {all ? copy('showLess') : copy('showAll', { n: entries.length })}
        </Button>
      )}
    </Card>
  );
}

const criterionLabel = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toLocaleUpperCase());

/** The latest score criterion by criterion, and every score below it. */
function ScoreCard({ data }: { data: ProspectGetOut }) {
  const { t, i18n } = useTranslation();
  const copy = usePoolCopy();
  const names = useLeadsNames();
  const key = useLeadsKey();
  const playbook = useQuery({ queryKey: [...key, 'prospects', 'playbook'], queryFn: getPlaybook, retry: false });
  const latest = data.scores[0];
  const rubric = playbook.data?.workspace.rubric;
  // Bars need the weights, which are the current rubric's: only when the score was made under it.
  const current = !!latest && !!rubric && playbook.data?.workspace.rubric_digest === latest.rubric_digest;
  const weight = (criterion: string) => (current ? rubric!.criteria.find((c) => c.key === criterion)?.weight : undefined);
  return (
    <Card title={copy('scoreCard')}>
      {!latest ? (
        <p className="text-sm text-muted-foreground">{t('leads.prospect.noScores')}</p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="text-lg font-semibold tabular-nums">{copy('scoreOf', { score: latest.score })}</span>
            {current && <span className="text-xs text-muted-foreground">{copy('threshold', { n: rubric!.qualify_at })}</span>}
            {!!rubric && !current && <span className="text-xs text-muted-foreground">{copy('olderRubric')}</span>}
          </p>
          <ul className="flex flex-col gap-2" aria-label={copy('scoreCard')}>
            {latest.reasons.map((r) => {
              const w = weight(r.criterion);
              return (
                <li key={r.criterion} className="flex flex-col gap-0.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-24 shrink-0 truncate font-medium" title={r.criterion}>{criterionLabel(r.criterion)}</span>
                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                      {w ? <span className="block h-full rounded-full bg-success" style={{ width: `${Math.min(100, (r.points / w) * 100)}%` }} /> : null}
                    </span>
                    <span className="shrink-0 tabular-nums">{w ? `${r.points}/${w}` : r.points}</span>
                  </div>
                  <span className="text-muted-foreground">{r.evidence}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <details className="group text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">{t('leads.prospect.scores')}</summary>
        <div className="pt-2">
          {data.scores.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('leads.prospect.noScores')}</p>
          ) : (
            <ol className="flex flex-col gap-3" aria-label={t('leads.prospect.scores')}>
              {data.scores.map((s) => (
                <li key={s.id} className="border-b border-border/60 pb-3 text-sm last:border-b-0" data-testid="score">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-base font-semibold tabular-nums">{s.score}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('leads.prospect.scoredBy', { at: formatDateTime(s.at, i18n.language), by: recorderText(t, names, s.recorder) })}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground" title={s.rubric_digest}>
                      {t('leads.prospect.digest', { digest: s.rubric_digest.slice(0, 12) })}
                    </span>
                  </div>
                  <table className="mt-2 w-full text-left text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="pe-2 font-normal">{t('leads.prospect.criterion')}</th>
                        <th className="pe-2 font-normal">{t('leads.prospect.points')}</th>
                        <th className="font-normal">{t('leads.prospect.why')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.reasons.map((r) => (
                        <tr key={r.criterion} className="align-top">
                          <td className="pe-2 font-mono">{r.criterion}</td>
                          <td className="pe-2 tabular-nums">{r.points}</td>
                          <td>
                            {r.evidence}
                            {r.source && (
                              <span className="block">
                                <SourceView source={r.source} />
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>
    </Card>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** One prospect: keyed by the prospect, so nothing typed for one carries over to another. */
function ProspectBody({ data }: { data: ProspectGetOut }) {
  const { t, i18n } = useTranslation();
  const copy = usePoolCopy();
  const session = useSession();
  const key = useLeadsKey();
  const names = useLeadsNames();
  const p = data.prospect;
  const inbox = can(session.data, 'inbox.work');
  const journey = useQuery({
    queryKey: [...key, 'journey', p.promoted?.journey_id],
    queryFn: () => getJourney(p.promoted!.journey_id),
    enabled: !!p.promoted && inbox,
    retry: false,
  });
  const person = useQuery({
    queryKey: [...key, 'person', p.promoted?.person_id],
    queryFn: () => getPerson(p.promoted!.person_id),
    enabled: !!p.promoted && inbox,
    retry: false,
  });
  const conversation = [...(person.data?.conversations ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  const conversationHref = !p.promoted || !inbox
    ? undefined
    : conversation
      ? `/inbox/${encodeURIComponent(conversation.id)}`
      : `/inbox?person=${encodeURIComponent(p.promoted.person_id)}`;
  const contactLabel = (name: string): string | null =>
    (CONTACT_KEYS as readonly string[]).includes(name) || name === 'contact_person' || name === 'size'
      ? t(`leads.fields.${name as ContactKey}`)
      : null;
  const fieldLabel = (name: string): string | null =>
    contactLabel(name) ??
    ({
      sector: t('leads.prospect.sector'),
      city: t('leads.prospect.place'),
      district: t('leads.prospect.place'),
      segment_key: t('leads.prospect.segment'),
      language: t('leads.prospect.language'),
      labels: t('leads.prospect.labels'),
      notes: copy('notes'),
      signals: t('leads.prospect.signals'),
    } as Record<string, string>)[name] ??
    null;
  const entries = buildTimeline(
    {
      copy,
      member: names.member,
      agent: names.agent,
      field: fieldLabel,
      contactField: contactLabel,
      rejectReason: (reason) => t(`leads.rejectReasons.${reason}` as never),
      dncReason: (reason) => t(`leads.dncReasons.${reason}` as never),
      via: (via) => t(`leads.originVia.${via}` as never),
      money: (minor, currency) => formatMoney(minor, currency, i18n.language),
    },
    data,
    journey.data,
    conversationHref,
  );
  const contactPerson: ProspectField<ContactPerson> | null | undefined = p.contact.contact_person;
  const hasContact = CONTACT_KEYS.some((k) => p.contact[k]) || !!contactPerson || !!p.size;
  const place = [p.district, p.city].filter(Boolean).join(', ');
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
        <Link to="/prospects" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          {copy('back')}
        </Link>
        <h2 className="font-display text-lg font-medium leading-7">{p.business_name}</h2>
        <ProspectStatusBadge status={p.status} />
        {p.latest_score && <Badge tone="neutral">{t('leads.prospect.score', { score: p.latest_score.score })}</Badge>}
        <span className="min-w-0 truncate text-sm text-muted-foreground">{[p.sector, place].filter(Boolean).join(' · ')}</span>
        <div className="ms-auto">
          <Actions data={data} conversationHref={conversationHref} />
        </div>
      </header>
      <StageSteps data={data} journey={journey.data} />
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:overflow-hidden">
        <div className="flex min-w-0 flex-col gap-5 p-4 xl:min-h-0 xl:overflow-y-auto">
          <NotesCard p={p} />
          <TimelineCard entries={entries} />
        </div>
        <div className="flex min-w-0 flex-col gap-5 border-t border-border bg-surface-muted/40 p-4 xl:min-h-0 xl:overflow-y-auto xl:border-s xl:border-t-0">
          <Card title={copy('contact')}>
            {/* The list stays in the page even when empty: it is what tells a reader the prospect has loaded. */}
            <ul aria-label={t('leads.prospect.fields')}>
              {CONTACT_KEYS.map((k) => {
                const field = p.contact[k];
                return field ? <FieldRow key={k} icon={CONTACT_ICON[k]} label={t(`leads.fields.${k}`)} field={field} text={field.value} /> : null;
              })}
              {contactPerson && (
                <FieldRow
                  icon={CONTACT_ICON.contact_person}
                  label={t('leads.fields.contact_person')}
                  field={contactPerson}
                  text={contactPerson.value.role ? `${contactPerson.value.name} (${contactPerson.value.role})` : contactPerson.value.name}
                />
              )}
              {p.size && <FieldRow icon={CONTACT_ICON.size} label={t('leads.fields.size')} field={p.size} text={sizeText(t, p.size.value)} />}
            </ul>
            {!hasContact && <p className="text-sm text-muted-foreground">{copy('noContact')}</p>}
          </Card>
          <Card title={copy('business')}>
            <Facts
              rows={[
                [t('leads.prospect.entity'), t(`leads.entityKinds.${p.entity_kind}`)],
                [t('leads.prospect.sector'), p.sector],
                [t('leads.prospect.place'), place || null],
                [t('leads.prospect.segment'), p.segment_key],
                [t('leads.prospect.language'), p.language],
                [t('leads.prospect.labels'), p.labels.length ? p.labels.join(', ') : null],
              ]}
            />
          </Card>
          {p.signals.length > 0 && (
            <Card title={t('leads.prospect.signals')}>
              <ul className="flex flex-col gap-2 text-sm" aria-label={t('leads.prospect.signals')}>
                {p.signals.map((s, i) => (
                  <li key={i} className="flex flex-col">
                    <span>{s.text}</span>
                    <span className="text-xs">
                      <SourceView source={s.source} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <ScoreCard data={data} />
          <Card title={copy('record')}>
            <Facts
              rows={[
                [t('leads.prospect.origin'), t(`leads.originVia.${p.origin.via}`)],
                [t('leads.prospect.recordedBy'), recorderText(t, names, p.origin.recorder)],
                [t('leads.prospect.created'), formatDateTime(p.created_at, i18n.language)],
                [t('leads.prospect.purgeAfter'), p.purge_after ? formatDateTime(p.purge_after, i18n.language) : null],
              ]}
            />
          </Card>
          {data.duplicate_candidates.length > 0 && (
            <Card title={t('leads.prospect.duplicates')}>
              <ul className="flex flex-col gap-1 text-sm" aria-label={t('leads.prospect.duplicates')}>
                {data.duplicate_candidates.map((d) => (
                  <li key={d.prospect_id} className="flex flex-wrap items-center gap-2">
                    <Link className="text-primary hover:underline" to={`/prospects/${encodeURIComponent(d.prospect_id)}`}>
                      {d.business_name}
                    </Link>
                    {d.city && <span className="text-muted-foreground">{d.city}</span>}
                    <ProspectStatusBadge status={d.status} />
                    <span className="text-xs text-muted-foreground">
                      {d.matched.map((m) => t(`leads.matched.${m === 'domain' ? 'domain' : 'name_city'}`)).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/** One prospect, in the pool's right pane (and alone on a narrow screen): notes, timeline, contact, score. */
export function ProspectPane({ prospectId }: { prospectId: string }) {
  const key = useLeadsKey();
  const prospect = useQuery({
    queryKey: [...key, 'prospects', 'one', prospectId],
    queryFn: () => getProspect(prospectId),
  });
  return (
    <QueryState query={prospect}>{prospect.data && <ProspectBody key={prospectId} data={prospect.data} />}</QueryState>
  );
}

