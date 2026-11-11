import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { backfill, getDistribution, listAssignments } from '@/api/distribution';
import * as api from '@/api/inbox';
import { getCampaign, listEnrollments, stopEnrollment } from '@/api/outreach';
import type { InboxAttachment, InboxEvent, InboxPerson, RecipientKind } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { Badge, Button, Disclosure, Textarea, toast } from '@/components/ui';
import { browser, fileUrl } from '@/lib/browser';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useInFlight } from '@/lib/leads';
import { can } from '@/lib/roles';
import { InboxTime, selectClass, useInboxKey, useInboxMutation, useMemberName } from './InboxShared';
import { SourceView } from './LeadsShared';

// The leads program in the inbox (spec 2026-10-30-leads-pool-outreach-design.md §9): the prospect
// a person was promoted from, their recipient kind, the sequence that writes to them, the owner
// assignments of their journey, the ownerless journeys, and email attachments.

const KINDS: readonly RecipientKind[] = ['unknown', 'business', 'individual'];

/** Why this business was chosen: the prospect's facts, evidence and latest score. */
export function ProspectFacts({ personId }: { personId: string }) {
  const { t, i18n } = useTranslation();
  const key = useInboxKey();
  const person = useQuery({ queryKey: [...key, 'person', personId], queryFn: () => api.getPerson(personId) });
  const p = person.data?.prospect;
  if (!p) return null;
  return (
    <section className="flex flex-col gap-2 border-t pt-4 text-sm" aria-label={t('inbox.leads.prospect')}>
      <h3 className="font-medium">{t('inbox.leads.prospect')}</h3>
      <Link className="text-primary hover:underline" to={`/prospects/${encodeURIComponent(p.prospect_id)}`}>
        {p.business_name}
      </Link>
      <p className="text-muted-foreground">
        {[p.sector, [p.district, p.city].filter(Boolean).join(', '), p.segment_key].filter(Boolean).join(' · ')}
      </p>
      <p>
        {t('inbox.leads.origin', { via: t(`leads.originVia.${p.origin}`) })}
        {p.latest_score && ` · ${t('leads.prospect.score', { score: p.latest_score.score })}`}
      </p>
      {p.reasons.length > 0 && (
        <ul className="flex flex-col gap-0.5" aria-label={t('leads.prospect.scores')}>
          {p.reasons.map((r) => (
            <li key={r.criterion}>
              <span className="font-mono">{r.criterion}</span> {r.points} · {r.evidence}
            </li>
          ))}
        </ul>
      )}
      {p.evidence.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label={t('leads.prospect.fields')}>
          {p.evidence.map((e) => (
            <li key={e.field} className="flex flex-col">
              <span>
                {t(`leads.fields.${e.field as 'phone'}`, { defaultValue: e.field })}
                {!e.deliverable && ` · ${t('leads.prospect.undeliverable')}`}
                {' · '}
                {formatDateTime(e.captured_at, i18n.language)}
              </span>
              {e.sources.map((s, i) => (
                <span key={i} className="text-caption">
                  <SourceView source={s} />
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
      {p.signals.length > 0 && (
        <ul className="list-disc ps-5" aria-label={t('leads.prospect.signals')}>
          {p.signals.map((s, i) => (
            <li key={i}>{s.text}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The recipient kind badge and, with `inbox.work`, its setter (a note goes on the journey). */
export function RecipientKindField({ person }: { person: InboxPerson }) {
  const { t } = useTranslation();
  const session = useSession();
  const guard = useInFlight();
  const current = person.recipient_kind ?? 'unknown';
  const [kind, setKind] = useState<RecipientKind>(current);
  const [note, setNote] = useState('');
  const save = useInboxMutation(
    () => api.setPersonKind(person.id, { kind, note: note.trim() || undefined }),
    () => setNote(''),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (kind === current) return;
    guard((release) => save.mutate(undefined, { onSettled: release }));
  };
  return (
    <section className="flex flex-col gap-2 border-t pt-4 text-sm" aria-label={t('inbox.leads.kind')}>
      <h3 className="flex items-center gap-2 font-medium">
        {t('inbox.leads.kind')}
        <Badge tone={current === 'business' ? 'info' : 'neutral'} data-testid="recipient-kind">
          {t(`leads.recipientKinds.${current}`)}
        </Badge>
      </h3>
      {can(session.data, 'inbox.work') && (
        <form className="flex flex-col gap-2" onSubmit={submit} aria-label={t('inbox.leads.setKind')}>
          <label className="flex flex-col gap-1">
            {t('inbox.leads.newKind')}
            <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as RecipientKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`leads.recipientKinds.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            {t('inbox.leads.kindNote')}
            <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </label>
          <ErrorCallout error={save.error} />
          <div>
            <Button type="submit" size="sm" variant="outline" disabled={kind === current} loading={save.isPending}>
              {t('inbox.leads.setKind')}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** The campaigns an outreach email of this journey came from, newest first. */
export function outreachCampaigns(events: InboxEvent[]): string[] {
  const out: string[] = [];
  for (const e of [...events].sort((a, b) => b.at.localeCompare(a.at))) {
    if (typeof e.kind === 'object' && 'outreach_sent' in e.kind && !out.includes(e.kind.outreach_sent.campaign_id)) {
      out.push(e.kind.outreach_sent.campaign_id);
    }
  }
  return out;
}

/** The most campaigns the panel looks the person's active enrollment up in. */
const SEQUENCE_CAMPAIGNS = 3;

/**
 * The sequence writing to the person: their active enrollment in a campaign this journey was
 * written to from, with its stop (`outreach.work`).
 */
export function ActiveSequence({ personId, events }: { personId: string; events: InboxEvent[] }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const key = useInboxKey();
  const allowed = can(session.data, 'outreach.work');
  const campaigns = outreachCampaigns(events).slice(0, SEQUENCE_CAMPAIGNS);
  const lists = useQueries({
    queries: campaigns.map((id) => ({
      queryKey: [...key, 'sequence', id],
      queryFn: () => listEnrollments(id, { status: 'active', limit: 200 }),
      enabled: allowed,
    })),
  });
  const found = lists
    .map((q) => q.data?.items.find((e) => e.person_id === personId))
    .find((e) => e !== undefined);
  const campaign = useQuery({
    queryKey: [...key, 'sequence-campaign', found?.campaign_id],
    queryFn: () => getCampaign(found!.campaign_id),
    enabled: !!found,
  });
  const stop = useInboxMutation(() => stopEnrollment(found!.id));
  if (!allowed || campaigns.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 border-t pt-4 text-sm" aria-label={t('inbox.leads.sequence')}>
      <h3 className="font-medium">{t('inbox.leads.sequence')}</h3>
      {found ? (
        <>
          <Link className="text-primary hover:underline" to={`/outreach/${encodeURIComponent(found.campaign_id)}`}>
            {campaign.data?.campaign.name ?? t('inbox.leads.campaign')}
          </Link>
          <p>
            {t('inbox.leads.nextStep', {
              n: found.next_step,
              at: found.next_send_at ? formatDateTime(found.next_send_at, i18n.language) : '—',
            })}
          </p>
          <ErrorCallout error={stop.error} />
          <div>
            <Button size="sm" variant="outline" loading={stop.isPending} onClick={() => !stop.isPending && stop.mutate()}>
              {t('inbox.leads.stopSequence')}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-muted-foreground">
          {lists.some((q) => q.isLoading) ? t('inbox.leads.looking') : t('inbox.leads.noSequence')}
        </p>
      )}
    </section>
  );
}

function causeText(t: TFunction, cause: string): string {
  return ['rule', 'default', 'manual', 'sla_reassign', 'member_left', 'import', 'no_eligible'].includes(cause)
    ? t(`leads.causes.${cause as 'rule'}`)
    : cause;
}

/** Who owned the journey and why: its assignment decisions, newest first. */
function AssignmentList({ journeyId }: { journeyId: string }) {
  const { t } = useTranslation();
  const key = useInboxKey();
  const memberName = useMemberName();
  const log = useQuery({ queryKey: [...key, 'assignments', journeyId], queryFn: () => listAssignments({ journey_id: journeyId }) });
  return (
    <QueryState query={log}>
      {log.data && log.data.items.length === 0 && <p className="text-sm text-muted-foreground">{t('inbox.leads.noAssignments')}</p>}
      <ol className="flex flex-col gap-1 text-sm" aria-label={t('inbox.leads.assignments')}>
        {log.data?.items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-baseline gap-2">
            <InboxTime at={a.assigned_at} />
            <span className="font-medium">{a.user_id ? memberName(a.user_id) : t('inbox.unassigned')}</span>
            <span className="text-muted-foreground">{causeText(t, a.cause)}</span>
          </li>
        ))}
      </ol>
    </QueryState>
  );
}

export function AssignmentHistory({ journeyId }: { journeyId: string }) {
  const { t } = useTranslation();
  return (
    <Disclosure title={t('inbox.leads.assignments')}>
      <AssignmentList journeyId={journeyId} />
    </Disclosure>
  );
}

/** The "Sahipsiz" queue: how many open journeys have no owner, the oldest one, and the backfill. */
export function OwnerlessQueue() {
  const { t } = useTranslation();
  const session = useSession();
  const key = useInboxKey();
  const manage = can(session.data, 'inbox.manage');
  const dist = useQuery({ queryKey: [...key, 'ownerless'], queryFn: getDistribution });
  const oldest = dist.data?.ownerless.oldest_journey_id ?? null;
  const journey = useQuery({
    queryKey: [...key, 'journey', oldest],
    queryFn: () => api.getJourney(oldest!),
    enabled: !!oldest,
  });
  const client = useQueryClient();
  const run = useMutation({
    mutationFn: () => backfill({}),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  return (
    <QueryState query={dist}>
      {dist.data && (
        <div className="flex flex-col gap-2 text-sm" data-testid="ownerless">
          <p className="font-medium">{t('inbox.leads.ownerlessCount', { n: dist.data.ownerless.count })}</p>
          {dist.data.stalled > 0 && <p>{t('inbox.leads.stalledCount', { n: dist.data.stalled })}</p>}
          {journey.data && (
            <Link
              className="text-primary hover:underline"
              to={`/inbox?person=${encodeURIComponent(journey.data.journey.person_id)}`}
            >
              {t('inbox.leads.oldest')}
            </Link>
          )}
          {manage && dist.data.ownerless.count > 0 && (
            <Button size="sm" loading={run.isPending} onClick={() => !run.isPending && run.mutate()}>
              {t('leads.distribution.backfill')}
            </Button>
          )}
          {run.data && <p role="status">{t('leads.distribution.backfillDone', { ...run.data })}</p>}
          <ErrorCallout error={run.error} />
          <Link className="text-primary hover:underline" to="/team/distribution">
            {t('inbox.leads.distributionLink')}
          </Link>
        </div>
      )}
    </QueryState>
  );
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One message's attachment: a download in a tab of its own (the address is signed on the click,
 * valid ten minutes), or why it is not there.
 */
export function AttachmentChip({ file }: { file: InboxAttachment }) {
  const { t } = useTranslation();
  const open = useMutation({
    mutationFn: async () => {
      const tab = browser.openPending();
      try {
        const out = await api.getAttachment(file.file_id);
        const url = out.download_url ? fileUrl(out.download_url) : null;
        if (url && tab) tab.go(url);
        else {
          tab?.close();
          if (!url) toast.error(t('inbox.attachments.gone'));
        }
      } catch (err) {
        tab?.close();
        throw err;
      }
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const available = file.state === 'stored' || file.state === 'attached';
  const label = `${file.filename} (${sizeText(file.size_bytes)})`;
  if (!available) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
        {label} ·{' '}
        {file.state === 'skipped'
          ? t(`inbox.attachments.skipped.${file.skip_reason ?? 'file_too_large'}`)
          : t(`inbox.attachments.states.${file.state}`)}
      </span>
    );
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label={t('inbox.attachments.download', { name: label })}
      loading={open.isPending}
      onClick={() => !open.isPending && open.mutate()}
    >
      {label}
    </Button>
  );
}

/** What the composer takes (`inbox.attachments_upload`). */
export const UPLOAD_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
export const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
export const MAX_ATTACHMENTS = 5;

async function base64Of(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A staged upload the next email carries. */
export interface Staged {
  file_id: string;
  filename: string;
  size_bytes: number;
}

/**
 * The composer's attachments (email only): each file uploaded once with its own request key,
 * staged until the reply carries it. The state belongs to the conversation's composer, which is
 * mounted afresh for another conversation (bug class "reused-component stale state").
 */
export function ComposerAttachments({ staged, onChange }: { staged: Staged[]; onChange: (s: Staged[]) => void }) {
  const { t } = useTranslation();
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async (file: File) =>
      api.uploadAttachment({
        request_key: crypto.randomUUID(),
        filename: file.name,
        mime: file.type,
        data_base64: await base64Of(file),
      }),
    onSuccess: (out) => onChange([...staged, { file_id: out.file_id, filename: out.filename, size_bytes: out.size_bytes }]),
  });
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setProblem(null);
    if (!file || upload.isPending) return;
    if (staged.length >= MAX_ATTACHMENTS) return setProblem(t('inbox.attachments.tooMany', { n: MAX_ATTACHMENTS }));
    if (!UPLOAD_TYPES.includes(file.type)) return setProblem(t('inbox.attachments.badType'));
    if (file.size > MAX_UPLOAD_BYTES) return setProblem(t('inbox.attachments.tooLarge'));
    upload.mutate(file);
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      <label className="flex flex-col gap-1">
        {t('inbox.attachments.add')}
        <input type="file" accept={UPLOAD_TYPES.join(',')} disabled={upload.isPending} onChange={pick} />
      </label>
      {staged.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label={t('inbox.attachments.staged')}>
          {staged.map((s) => (
            <li key={s.file_id} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
              {s.filename} ({sizeText(s.size_bytes)})
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={t('inbox.attachments.remove', { name: s.filename })}
                onClick={() => onChange(staged.filter((x) => x.file_id !== s.file_id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {problem && <p className="text-danger">{problem}</p>}
      <ErrorCallout error={upload.error} />
    </div>
  );
}
