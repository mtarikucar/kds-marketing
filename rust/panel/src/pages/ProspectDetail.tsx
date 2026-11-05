import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { decideProspect, eraseProspect, getProspect, promoteProspects } from '@/api/prospects';
import type { ContactPerson, Prospect, ProspectField, ProspectGetOut, SizeHint } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
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
  PageHeader,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useDraftKey, useInFlight } from '@/lib/leads';
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
import { promoteOutcomeText } from './ProspectsPage';

type ContactKey = 'phone' | 'email' | 'website' | 'instagram' | 'tiktok' | 'address';
const CONTACT_KEYS: readonly ContactKey[] = ['phone', 'email', 'website', 'instagram', 'tiktok', 'address'];

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

/** One field with its evidence: the sources, when it was seen, who recorded it. */
function FieldRow<T>({ label, field, text }: { label: string; field: ProspectField<T>; text: string }) {
  const { t, i18n } = useTranslation();
  const names = useLeadsNames();
  return (
    <li className="flex flex-col gap-1 border-b border-border py-2 last:border-b-0" data-testid="prospect-field">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="break-all font-medium">{text}</span>
        {!field.deliverable && <Badge tone="warning">{t('leads.prospect.undeliverable')}</Badge>}
      </div>
      <ul className="flex flex-col gap-0.5 text-caption" aria-label={t('leads.prospect.sourcesOf', { field: label })}>
        {field.evidence.sources.map((s, i) => (
          <li key={i}>
            <SourceView source={s} />
          </li>
        ))}
      </ul>
      <span className="text-caption text-muted-foreground">
        {t('leads.prospect.evidence', {
          at: formatDateTime(field.evidence.captured_at, i18n.language),
          by: recorderText(t, names, field.evidence.recorder),
        })}
      </span>
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

/** The actions a prospect's status allows the signed-in person. */
function Actions({ data }: { data: ProspectGetOut }) {
  const { t } = useTranslation();
  const session = useSession();
  const refresh = useLeadsRefresh();
  const draft = useDraftKey();
  const p = data.prospect;
  const manage = can(session.data, 'prospects.manage');
  const inbox = can(session.data, 'inbox.work');
  const [dialog, setDialog] = useState<'reject' | 'dnc' | 'erase' | null>(null);
  const decide = useMutation({
    mutationFn: (decision: 'qualify' | 'reopen') => decideProspect(p.id, { decision, expected_revision: p.revision }),
    onSuccess: async () => {
      toast.success(t('leads.prospect.saved'));
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const promote = useMutation({
    mutationFn: () => promoteProspects({ prospect_ids: [p.id], request_key: draft.keyFor({ ids: [p.id] }) }),
    onSuccess: async (out) => {
      const outcome = out.items[0];
      if (outcome?.outcome === 'refused') toast.error(promoteOutcomeText(t, outcome));
      else toast.success(t('leads.outcome.promoted'));
      draft.reset();
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
  return (
    <div className="flex flex-wrap gap-2">
      {p.status === 'new' && (
        <Button variant="outline" loading={decide.isPending && decide.variables === 'qualify'} disabled={decide.isPending} onClick={() => decide.mutate('qualify')}>
          {t('leads.actions.qualify')}
        </Button>
      )}
      {open && inbox && (
        <Button loading={promote.isPending} onClick={() => !promote.isPending && promote.mutate()}>
          {t('leads.actions.promote')}
        </Button>
      )}
      {open && (
        <Button variant="outline" onClick={() => setDialog('reject')}>
          {t('leads.actions.reject')}
        </Button>
      )}
      {p.status === 'rejected' && manage && (
        <Button variant="outline" loading={decide.isPending && decide.variables === 'reopen'} disabled={decide.isPending} onClick={() => decide.mutate('reopen')}>
          {t('leads.actions.reopen')}
        </Button>
      )}
      {p.status !== 'promoted' && p.status !== 'do_not_contact' && (
        <Button variant="outline" className="text-danger" onClick={() => setDialog('dnc')}>
          {t('leads.actions.dnc')}
        </Button>
      )}
      {manage && p.status !== 'promoted' && (
        <Button variant="destructive" onClick={() => setDialog('erase')}>
          {t('leads.actions.erase')}
        </Button>
      )}
      {p.promoted && (
        <Button asChild variant="ghost">
          <Link to={`/inbox?person=${encodeURIComponent(p.promoted.person_id)}`}>{t('leads.prospect.openInInbox')}</Link>
        </Button>
      )}
      {dialog === 'reject' && <RejectDialog targets={target} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'dnc' && <DncDialog targets={target} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'erase' && <EraseDialog prospect={p} onClose={() => setDialog(null)} />}
    </div>
  );
}

/** A prospect's page body; keyed by the prospect, so nothing typed for one carries over to another. */
function ProspectBody({ data }: { data: ProspectGetOut }) {
  const { t, i18n } = useTranslation();
  const names = useLeadsNames();
  const p = data.prospect;
  const facts: [string, string | null][] = [
    [t('leads.prospect.entity'), t(`leads.entityKinds.${p.entity_kind}`)],
    [t('leads.prospect.sector'), p.sector],
    [t('leads.prospect.place'), [p.district, p.city].filter(Boolean).join(', ') || null],
    [t('leads.prospect.segment'), p.segment_key],
    [t('leads.prospect.language'), p.language],
    [t('leads.prospect.labels'), p.labels.length ? p.labels.join(', ') : null],
    [t('leads.prospect.origin'), t(`leads.originVia.${p.origin.via}`)],
    [t('leads.prospect.recordedBy'), recorderText(t, names, p.origin.recorder)],
    [t('leads.prospect.created'), formatDateTime(p.created_at, i18n.language)],
    [t('leads.prospect.purgeAfter'), p.purge_after ? formatDateTime(p.purge_after, i18n.language) : null],
  ];
  const person: ProspectField<ContactPerson> | null | undefined = p.contact.contact_person;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <section className="border-b border-border px-4 py-5 last:border-b-0 sm:px-6">
        <header className="flex flex-wrap items-center gap-2 pb-4">
          <h2 className="text-base font-medium">{p.business_name}</h2>
          <ProspectStatusBadge status={p.status} />
          {p.latest_score && <Badge tone="neutral">{t('leads.prospect.score', { score: p.latest_score.score })}</Badge>}
        </header>
        <div className="flex flex-col gap-4">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            {facts
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k} className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-3">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
          {p.decision && (
            <p className="text-sm">
              {'rejected' in p.decision.kind
                ? t('leads.prospect.rejectedFor', { reason: t(`leads.rejectReasons.${p.decision.kind.rejected}`) })
                : t('leads.prospect.blockedFor', { reason: t(`leads.dncReasons.${p.decision.kind.do_not_contact}`) })}
              {p.decision.note && ` · ${p.decision.note}`}
            </p>
          )}
          <Actions data={data} />
        </div>
      </section>

      <section className="border-b border-border px-4 py-5 last:border-b-0 sm:px-6">
        <header className="mb-3">
          <h2 className="text-base font-medium">{t('leads.prospect.fields')}</h2>
        </header>
        <div>
          <ul aria-label={t('leads.prospect.fields')}>
            {CONTACT_KEYS.map((k) => {
              const field = p.contact[k];
              return field ? <FieldRow key={k} label={t(`leads.fields.${k}`)} field={field} text={field.value} /> : null;
            })}
            {person && (
              <FieldRow
                label={t('leads.fields.contact_person')}
                field={person}
                text={person.value.role ? `${person.value.name} (${person.value.role})` : person.value.name}
              />
            )}
            {p.size && <FieldRow label={t('leads.fields.size')} field={p.size} text={sizeText(t, p.size.value)} />}
          </ul>
          {p.notes && <p className="mt-3 whitespace-pre-wrap text-sm">{p.notes}</p>}
        </div>
      </section>

      {p.signals.length > 0 && (
        <section className="border-b border-border px-4 py-5 last:border-b-0 sm:px-6">
          <header className="mb-3">
            <h2 className="text-base font-medium">{t('leads.prospect.signals')}</h2>
          </header>
          <div>
            <ul className="flex flex-col gap-2 text-sm" aria-label={t('leads.prospect.signals')}>
              {p.signals.map((s, i) => (
                <li key={i} className="flex flex-col">
                  <span>{s.text}</span>
                  <span className="text-caption">
                    <SourceView source={s.source} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <details className="group border-b border-border px-4 py-5 last:border-b-0 sm:px-6">
        <summary className="cursor-pointer text-base font-medium">{t('leads.prospect.scores')}</summary>
        <div className="pt-3">
          {data.scores.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('leads.prospect.noScores')}</p>
          ) : (
            <ol className="flex flex-col gap-3" aria-label={t('leads.prospect.scores')}>
              {data.scores.map((s) => (
                <li key={s.id} className="border-b border-border py-3 text-sm last:border-b-0" data-testid="score">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-lg font-semibold tabular-nums">{s.score}</span>
                    <span className="text-caption text-muted-foreground">
                      {t('leads.prospect.scoredBy', {
                        at: formatDateTime(s.at, i18n.language),
                        by: recorderText(t, names, s.recorder),
                      })}
                    </span>
                    <span className="font-mono text-caption text-muted-foreground" title={s.rubric_digest}>
                      {t('leads.prospect.digest', { digest: s.rubric_digest.slice(0, 12) })}
                    </span>
                  </div>
                  <table className="mt-2 w-full text-left text-sm">
                    <thead className="text-caption text-muted-foreground">
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
                              <span className="block text-caption">
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

      <details className="group border-b border-border px-4 py-5 last:border-b-0 sm:px-6">
        <summary className="cursor-pointer text-base font-medium">{t('leads.prospect.duplicates')}</summary>
        <div className="pt-3">
          {data.duplicate_candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('leads.prospect.noDuplicates')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm" aria-label={t('leads.prospect.duplicates')}>
              {data.duplicate_candidates.map((d) => (
                <li key={d.prospect_id} className="flex flex-wrap items-center gap-2">
                  <Link className="text-primary hover:underline" to={`/prospects/${encodeURIComponent(d.prospect_id)}`}>
                    {d.business_name}
                  </Link>
                  {d.city && <span className="text-muted-foreground">{d.city}</span>}
                  <ProspectStatusBadge status={d.status} />
                  <span className="text-caption text-muted-foreground">
                    {d.matched.map((m) => t(`leads.matched.${m === 'domain' ? 'domain' : 'name_city'}`)).join(', ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <details className="group border-b border-border px-4 py-5 last:border-b-0 sm:px-6">
        <summary className="cursor-pointer text-base font-medium">{t('leads.prospect.history')}</summary>
        <div className="pt-3">
          {data.ledger.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('leads.prospect.noHistory')}</p>
          ) : (
            <ol className="flex flex-col gap-1 text-sm" aria-label={t('leads.prospect.history')}>
              {data.ledger.map((row) => (
                <li key={row.id} className="flex flex-wrap gap-2">
                  <span className="text-muted-foreground">{formatDateTime(row.entry.at, i18n.language)}</span>
                  <span className="font-mono">{row.entry.action}</span>
                  <span className="text-muted-foreground">
                    {row.entry.actor.kind === 'human'
                      ? names.member(row.entry.actor.user_id)
                      : row.entry.actor.kind === 'agent'
                        ? names.agent(row.entry.actor.connection_id)
                        : t('leads.recorder.system', { job: row.entry.actor.component })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>
    </div>
  );
}

/** `/prospects/:prospectId`: one prospect, its evidence, scores, duplicates and history (spec §9). */
export function ProspectDetail() {
  const { t } = useTranslation();
  const { prospectId = '' } = useParams();
  const key = useLeadsKey();
  const prospect = useQuery({
    queryKey: [...key, 'prospects', 'one', prospectId],
    queryFn: () => getProspect(prospectId),
  });
  return (
    <>
      <PageHeader
        title={prospect.data?.prospect.business_name ?? t('leads.prospect.title')}
        actions={
          <Button asChild variant="outline">
            <Link to="/prospects">{t('leads.prospect.back')}</Link>
          </Button>
        }
      />
      <QueryState query={prospect}>{prospect.data && <ProspectBody key={prospectId} data={prospect.data} />}</QueryState>
    </>
  );
}
