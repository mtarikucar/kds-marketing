import { useEffect, useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listCapabilities } from '@/api/capabilities';
import {
  approveCampaign,
  controlCampaign,
  getCampaign,
  launchCampaign,
  listEnrollments,
  listTemplates,
  previewAudience,
  saveCampaign,
  stopEnrollment,
} from '@/api/outreach';
import type {
  Audience,
  CampaignDefinition,
  CampaignOut,
  CampaignStep,
  ControlAction,
  EnrollmentRow,
  JourneyStatus,
  PeopleFilter,
  ProspectFilter,
  RecipientKind,
} from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Disclosure,
  EmptyState,
  Input,
  PageHeader,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useDraftKey, useInFlight } from '@/lib/leads';
import { can } from '@/lib/roles';
import { selectClass } from './InboxShared';
import { CampaignReport } from './LeadsReport';
import { HoursFields, ListInput, useLeadsKey, useLeadsNames, useLeadsRefresh } from './LeadsShared';
import { CampaignStatusBadge, LockNotice, launchBlockers, skipText, stopText, useOutreachSettings } from './OutreachShared';

/** The open journey stages a people filter offers. */
const OPEN_STAGES = ['new', 'contacted', 'unreachable', 'appointment', 'met', 'quoted', 'pending'] as const satisfies readonly JourneyStatus[];
const MAX_STEPS = 6;


function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function newDefinition(senderName: string, clickTracking: boolean): CampaignDefinition {
  return {
    sender_name: senderName,
    steps: [],
    audience: { people: null, prospects: { segment_keys: [], research_task_ids: [], cities: [], sectors: [], min_score: null }, explicit: [] },
    schedule: { start_at: null, window: { tz: localZone(), from: 9, to: 18, days: [1, 2, 3, 4, 5] } },
    throttle: { per_hour: 10, per_day: 50 },
    click_tracking: clickTracking,
    evergreen: false,
    segment_key: null,
  };
}

/** A value that settles `ms` after its last change (the audience preview asks once typing stops). */
function useSettled<T>(value: T, ms = 400): T {
  const [settled, setSettled] = useState(value);
  const text = JSON.stringify(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
    // The text stands for the value: a new object with the same content changes nothing.
  }, [text, ms]);
  return settled;
}

/** The audience's counts as enrollment would compute them, with the skip reasons; nothing written. */
function AudiencePreview({ audience, mailboxId }: { audience: Audience; mailboxId: string }) {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const settled = useSettled({ audience, mailboxId });
  const preview = useQuery({
    queryKey: [...key, 'outreach', 'preview', settled],
    queryFn: () => previewAudience({ audience: settled.audience, mailbox_id: settled.mailboxId }),
    enabled: settled.mailboxId !== '',
    placeholderData: keepPreviousData,
  });
  if (!mailboxId) return <p className="text-sm text-muted-foreground">{t('leads.campaign.preview.chooseMailbox')}</p>;
  const p = preview.data;
  return (
    <section className="flex flex-col gap-2 rounded-lg bg-surface-muted p-3 text-sm" aria-label={t('leads.campaign.preview.title')}>
      <h3 className="font-medium">{t('leads.campaign.preview.title')}</h3>
      <QueryState query={preview}>
        {p && (
          <>
            <p className="text-base font-semibold">{t('leads.campaign.preview.eligible', { n: p.eligible })}</p>
            <p>
              {t('leads.campaign.preview.basis', { consent: p.basis.consent, business: p.basis.business_recipient })}
            </p>
            {p.promotions_needed > 0 && <p>{t('leads.campaign.preview.promotions', { n: p.promotions_needed })}</p>}
            {!p.business_basis_in_force && <p className="text-muted-foreground">{t('leads.campaign.preview.noB2b')}</p>}
            {Object.keys(p.by_skip_reason).length > 0 && (
              <ul className="flex flex-col gap-0.5" aria-label={t('leads.campaign.preview.skipped')}>
                {Object.entries(p.by_skip_reason).map(([reason, n]) => (
                  <li key={reason}>{t('leads.campaign.preview.skip', { reason: skipText(t, reason), n: n })}</li>
                ))}
              </ul>
            )}
            {p.truncated && <p className="text-muted-foreground">{t('leads.campaign.preview.truncated')}</p>}
          </>
        )}
      </QueryState>
    </section>
  );
}

/** The steps: a template each, the delay after the previous, and whether it answers in the same thread. */
function StepsEditor({ steps, onChange }: { steps: CampaignStep[]; onChange: (steps: CampaignStep[]) => void }) {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const templates = useQuery({ queryKey: [...key, 'outreach', 'templates', false], queryFn: () => listTemplates() });
  const options = (templates.data?.items ?? []).filter((x) => !x.template.archived);
  const set = (i: number, patch: Partial<CampaignStep>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{t('leads.campaign.steps')}</legend>
      <ol className="flex flex-col gap-2" aria-label={t('leads.campaign.steps')}>
        {steps.map((s, i) => (
          <li key={i} className="grid gap-2 rounded-lg border border-border p-2 sm:grid-cols-[1fr_8rem_auto_auto]">
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.campaign.stepTemplate', { n: i + 1 })}
              <select className={selectClass} value={s.template_id} onChange={(e) => set(i, { template_id: e.target.value })}>
                <option value="">{t('leads.campaign.chooseTemplate')}</option>
                {options.map(({ template }) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.campaign.delay')}
              <Input
                type="number"
                min={i === 0 ? 0 : 1}
                max={30}
                disabled={i === 0}
                value={s.delay_days}
                onChange={(e) => set(i, { delay_days: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center gap-1 self-end pb-2 text-sm">
              <input
                type="checkbox"
                disabled={i === 0}
                checked={s.same_thread}
                onChange={(e) => set(i, { same_thread: e.target.checked })}
              />
              {t('leads.campaign.sameThread')}
            </label>
            <Button type="button" size="sm" variant="ghost" className="self-end" onClick={() => onChange(steps.filter((_, j) => j !== i))}>
              {t('leads.campaign.removeStep')}
            </Button>
          </li>
        ))}
      </ol>
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={steps.length >= MAX_STEPS}
          onClick={() =>
            onChange([...steps, { template_id: '', delay_days: steps.length === 0 ? 0 : 3, same_thread: steps.length > 0 }])
          }
        >
          {t('leads.campaign.addStep')}
        </Button>
      </div>
    </fieldset>
  );
}

/** The audience builder: qualified prospects of the pool, inbox people, or both. */
function AudienceEditor({ audience, onChange }: { audience: Audience; onChange: (a: Audience) => void }) {
  const { t } = useTranslation();
  const pros: ProspectFilter | null = audience.prospects ?? null;
  const people: PeopleFilter | null = audience.people ?? null;
  const setPros = (patch: Partial<ProspectFilter>) => onChange({ ...audience, prospects: { ...(pros ?? {}), ...patch } });
  const setPeople = (patch: Partial<PeopleFilter>) => onChange({ ...audience, people: { ...(people ?? {}), ...patch } });
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">{t('leads.campaign.audience')}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={pros !== null}
          onChange={(e) =>
            onChange({ ...audience, prospects: e.target.checked ? { segment_keys: [], cities: [], sectors: [], min_score: null } : null })
          }
        />
        {t('leads.campaign.fromPool')}
      </label>
      {pros && (
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.campaign.segments')}
            <ListInput value={pros.segment_keys} onChange={(items) => setPros({ segment_keys: items })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.campaign.cities')}
            <ListInput value={pros.cities} onChange={(items) => setPros({ cities: items })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.campaign.sectors')}
            <ListInput value={pros.sectors} onChange={(items) => setPros({ sectors: items })} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t('leads.campaign.minScore')}
            <Input
              type="number"
              min={0}
              max={100}
              value={pros.min_score ?? ''}
              onChange={(e) => setPros({ min_score: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </label>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={people !== null}
          onChange={(e) => onChange({ ...audience, people: e.target.checked ? { journey_statuses: [] } : null })}
        />
        {t('leads.campaign.fromInbox')}
      </label>
      {people && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2 text-sm" role="group" aria-label={t('leads.campaign.stages')}>
            {OPEN_STAGES.map((s) => (
              <label key={s} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
                <input
                  type="checkbox"
                  checked={(people.journey_statuses ?? []).includes(s)}
                  onChange={(e) =>
                    setPeople({
                      journey_statuses: e.target.checked
                        ? [...(people.journey_statuses ?? []), s]
                        : (people.journey_statuses ?? []).filter((x) => x !== s),
                    })
                  }
                />
                {t(`leads.journeyStages.${s}`)}
              </label>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.campaign.recipientKind')}
              <select
                className={selectClass}
                value={people.recipient_kind ?? ''}
                onChange={(e) => setPeople({ recipient_kind: (e.target.value || null) as RecipientKind | null })}
              >
                <option value="">{t('leads.prospects.filters.all')}</option>
                <option value="business">{t('leads.recipientKinds.business')}</option>
                <option value="individual">{t('leads.recipientKinds.individual')}</option>
                <option value="unknown">{t('leads.recipientKinds.unknown')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.campaign.segments')}
              <ListInput value={people.segments} onChange={(items) => setPeople({ segments: items })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.campaign.cities')}
              <ListInput value={people.cities} onChange={(items) => setPeople({ cities: items })} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.campaign.sectors')}
              <ListInput value={people.sectors} onChange={(items) => setPeople({ sectors: items })} />
            </label>
          </div>
        </div>
      )}
    </fieldset>
  );
}

/**
 * The campaign's editor (a draft, or a paused campaign): one save makes the next revision and
 * voids any approval. Keyed by campaign and revision, so nothing typed carries over to another.
 */
function CampaignEditor({ out }: { out: CampaignOut | null }) {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const key = useLeadsKey();
  const refresh = useLeadsRefresh();
  const settings = useOutreachSettings();
  const draftKey = useDraftKey();
  const guard = useInFlight();
  const mailboxes = useQuery({ queryKey: [...key, 'capabilities', 'mailbox'], queryFn: () => listCapabilities({ kind: 'mailbox' }) });
  const c = out?.campaign ?? null;
  const [name, setName] = useState(c?.name ?? '');
  const [mailboxId, setMailboxId] = useState(c?.mailbox_id ?? '');
  const [def, setDef] = useState<CampaignDefinition>(
    () => c?.definition ?? newDefinition(session.data?.display_name ?? '', settings.data?.click_tracking_default ?? false),
  );
  const set = (patch: Partial<CampaignDefinition>) => setDef((d) => ({ ...d, ...patch }));
  const save = useMutation({
    mutationFn: () => {
      const definition: CampaignDefinition = { ...def, steps: def.steps.map(({ snapshot: _s, ...step }) => step) };
      const input = c
        ? { campaign_id: c.id, expected_revision: c.revision, name: name.trim(), mailbox_id: mailboxId, definition }
        : { name: name.trim(), mailbox_id: mailboxId, definition };
      return saveCampaign(c ? input : { ...input, request_key: draftKey.keyFor(input) });
    },
    onSuccess: async (saved) => {
      toast.success(t('leads.campaign.saved'));
      draftKey.reset();
      await refresh();
      if (!c) navigate(`/outreach/${encodeURIComponent(saved.campaign.id)}`, { replace: true });
    },
  });
  const valid =
    name.trim() !== '' &&
    mailboxId !== '' &&
    def.sender_name.trim() !== '' &&
    def.steps.length > 0 &&
    def.steps.every((s) => s.template_id) &&
    def.throttle.per_hour >= 1 &&
    def.throttle.per_hour <= 60 &&
    def.throttle.per_day >= 1 &&
    def.throttle.per_day <= 500;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => save.mutate(undefined, { onSettled: release }));
  };
  const startLocal = def.schedule.start_at ? def.schedule.start_at.slice(0, 16) : '';
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} aria-label={t('leads.campaign.editor')}>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.campaign.name')}
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.campaign.mailbox')}
          <select className={selectClass} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
            <option value="">{t('leads.campaign.chooseMailbox')}</option>
            {(mailboxes.data ?? []).map(({ capability }) => (
              <option key={capability.id} value={capability.id}>
                {capability.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.campaign.senderName')}
          <Input value={def.sender_name} maxLength={80} onChange={(e) => set({ sender_name: e.target.value })} />
        </label>
      </div>
      <StepsEditor steps={def.steps} onChange={(steps) => set({ steps })} />
      <AudienceEditor audience={def.audience} onChange={(audience) => set({ audience })} />
      <AudiencePreview audience={def.audience} mailboxId={mailboxId} />
      <HoursFields
        label={t('leads.campaign.window')}
        value={def.schedule.window}
        onChange={(window) => window && set({ schedule: { ...def.schedule, window } })}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.campaign.startAt')}
          <Input
            type="datetime-local"
            value={startLocal}
            onChange={(e) =>
              set({ schedule: { ...def.schedule, start_at: e.target.value ? new Date(e.target.value).toISOString() : null } })
            }
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.campaign.perHour')}
          <Input
            type="number"
            min={1}
            max={60}
            value={def.throttle.per_hour}
            onChange={(e) => set({ throttle: { ...def.throttle, per_hour: Number(e.target.value) } })}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.campaign.perDay')}
          <Input
            type="number"
            min={1}
            max={500}
            value={def.throttle.per_day}
            onChange={(e) => set({ throttle: { ...def.throttle, per_day: Number(e.target.value) } })}
          />
        </label>
      </div>
      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={def.click_tracking} onChange={(e) => set({ click_tracking: e.target.checked })} />
          {t('leads.campaign.clickTracking')}
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={def.evergreen} onChange={(e) => set({ evergreen: e.target.checked })} />
          {t('leads.campaign.evergreen')}
        </label>
      </div>
      {c?.approval && <p className="text-sm text-muted-foreground">{t('leads.campaign.saveVoidsApproval')}</p>}
      <ErrorCallout error={save.error} />
      <div>
        <Button type="submit" disabled={!valid} loading={save.isPending}>
          {c ? t('leads.campaign.saveRevision') : t('leads.campaign.create')}
        </Button>
      </div>
    </form>
  );
}

/** A launched revision waiting for a person with `outreach.manage`; others only see that it waits. */
function ApprovalCard({ out }: { out: CampaignOut }) {
  const { t } = useTranslation();
  const session = useSession();
  const names = useLeadsNames();
  const refresh = useLeadsRefresh();
  const c = out.campaign;
  const manager = can(session.data, 'outreach.manage');
  const approve = useMutation({
    mutationFn: () => approveCampaign(c.id, c.revision),
    onSuccess: async () => {
      toast.success(t('leads.campaign.approved'));
      await refresh();
    },
  });
  const drafter =
    c.created_by.kind === 'human'
      ? names.member(c.created_by.user_id)
      : c.created_by.kind === 'agent'
        ? t('leads.recorder.agentNamed', { name: names.agent(c.created_by.connection_id), member: names.member(c.created_by.user_id) })
        : t('leads.recorder.system', { job: c.created_by.component });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('leads.campaign.approval.title')}</CardTitle>
        <CardDescription>
          {t('leads.campaign.approval.body', { revision: c.revision, drafter })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {manager ? (
          <>
            <ErrorCallout error={approve.error} />
            <div>
              <Button loading={approve.isPending} onClick={() => !approve.isPending && approve.mutate()}>
                {t('leads.campaign.approval.approve', { revision: c.revision })}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('leads.campaign.approval.waiting')}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** One run control (launch, pause, resume, cancel), pending on its own. */
function ControlButton({
  label,
  run,
  variant = 'outline',
  disabled,
}: {
  label: string;
  run: () => Promise<unknown>;
  variant?: 'outline' | 'primary' | 'destructive';
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const refresh = useLeadsRefresh();
  const act = useMutation({
    mutationFn: run,
    onSuccess: async () => {
      toast.success(t('leads.campaign.done'));
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  return (
    <Button variant={variant} disabled={disabled} loading={act.isPending} onClick={() => !act.isPending && act.mutate()}>
      {label}
    </Button>
  );
}

/** Launch, pause, resume and cancel as the status allows; why a launch is blocked, when it is. */
function RunControls({ out }: { out: CampaignOut }) {
  const { t } = useTranslation();
  const session = useSession();
  const settings = useOutreachSettings();
  const c = out.campaign;
  const manager = can(session.data, 'outreach.manage');
  const blockers = launchBlockers(t, settings.data);
  const control = (action: ControlAction) => () => controlCampaign(c.id, action);
  const final = c.status === 'completed' || c.status === 'canceled';
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('leads.campaign.run')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {(c.status === 'draft' || c.status === 'paused') && blockers.length > 0 && (
          <section aria-label={t('leads.campaign.blockedTitle')}>
            <p className="text-sm font-medium">{t('leads.campaign.blockedTitle')}</p>
            <ul className="list-disc ps-5 text-sm" aria-label={t('leads.campaign.blockedTitle')}>
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </section>
        )}
        {c.pause_reason && <p className="text-sm">{t('leads.campaign.pausedFor', { reason: t(`leads.pauseReasons.${c.pause_reason}`) })}</p>}
        {out.approval_required && c.status === 'draft' && (
          <p className="text-sm text-muted-foreground">
            {manager ? t('leads.campaign.launchApproves') : t('leads.campaign.launchNeedsApproval')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {c.status === 'draft' && (
            <ControlButton
              label={t('leads.campaign.launch')}
              variant="primary"
              disabled={blockers.length > 0 || c.definition.steps.length === 0}
              run={() => launchCampaign(c.id, c.revision)}
            />
          )}
          {(c.status === 'running' || c.status === 'scheduled') && (
            <ControlButton label={t('leads.campaign.pause')} run={control('pause')} />
          )}
          {c.status === 'paused' && (
            <ControlButton label={t('leads.campaign.resume')} disabled={blockers.length > 0} run={control('resume')} />
          )}
          {!final && c.status !== 'draft' && manager && (
            <ControlButton label={t('leads.campaign.cancel')} variant="destructive" run={control('cancel')} />
          )}
        </div>
        <p className="text-caption text-muted-foreground">
          {t('leads.campaign.active', { n: out.active_enrollments })}
        </p>
      </CardContent>
    </Card>
  );
}

/** One enrollment: its own stop, pending on its own (bug class "per-row mutation loading"). */
function EnrollmentItem({ row }: { row: EnrollmentRow }) {
  const { t, i18n } = useTranslation();
  const refresh = useLeadsRefresh();
  const stop = useMutation({
    mutationFn: () => stopEnrollment(row.id),
    onSuccess: async () => {
      toast.success(t('leads.enrollments.stopped'));
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  return (
    <tr className="border-t border-border align-top" data-testid="enrollment">
      <td className="py-2 pe-3">
        <Link className="text-primary hover:underline" to={`/inbox?person=${encodeURIComponent(row.person_id)}`}>
          {t('leads.enrollments.openPerson')}
        </Link>
        {row.prospect_id && (
          <Link className="ms-2 text-caption text-muted-foreground hover:underline" to={`/prospects/${encodeURIComponent(row.prospect_id)}`}>
            {t('leads.enrollments.prospect')}
          </Link>
        )}
      </td>
      <td className="py-2 pe-3">
        <Badge tone={row.status === 'active' ? 'success' : 'neutral'}>{t(`leads.enrollmentStatus.${row.status}`)}</Badge>
        {row.stop && <span className="block text-caption">{stopText(t, row.stop)}</span>}
        {row.skip && <span className="block text-caption">{skipText(t, row.skip)}</span>}
      </td>
      <td className="py-2 pe-3 tabular-nums">{Math.min(row.next_step, MAX_STEPS)}</td>
      <td className="py-2 pe-3">{row.next_send_at ? formatDateTime(row.next_send_at, i18n.language) : '—'}</td>
      <td className="py-2 pe-3">{row.basis ? t(`leads.basis.${row.basis}`) : '—'}</td>
      <td className="py-2 text-end">
        {row.status === 'active' && (
          <Button size="sm" variant="ghost" loading={stop.isPending} onClick={() => !stop.isPending && stop.mutate()}>
            {t('leads.enrollments.stop')}
          </Button>
        )}
      </td>
    </tr>
  );
}

function Enrollments({ campaignId }: { campaignId: string }) {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const list = useQuery({ queryKey: [...key, 'outreach', 'enrollments', campaignId], queryFn: () => listEnrollments(campaignId) });
  const items = list.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('leads.enrollments.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryState query={list}>
          {items.length === 0 ? (
            <EmptyState title={t('leads.enrollments.empty')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" aria-label={t('leads.enrollments.title')}>
                <thead className="text-caption text-muted-foreground">
                  <tr>
                    <th className="py-1 pe-3 font-normal">{t('leads.enrollments.person')}</th>
                    <th className="py-1 pe-3 font-normal">{t('leads.enrollments.status')}</th>
                    <th className="py-1 pe-3 font-normal">{t('leads.enrollments.step')}</th>
                    <th className="py-1 pe-3 font-normal">{t('leads.enrollments.next')}</th>
                    <th className="py-1 pe-3 font-normal">{t('leads.enrollments.basis')}</th>
                    <th className="py-1 font-normal">
                      <span className="sr-only">{t('common.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <EnrollmentItem key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryState>
      </CardContent>
    </Card>
  );
}

/** `/outreach/new` and `/outreach/:campaignId`: one campaign's editor, approval, run and enrollments (spec §9). */
export function OutreachCampaign() {
  const { t } = useTranslation();
  const { campaignId = '' } = useParams();
  const key = useLeadsKey();
  const settings = useOutreachSettings();
  const isNew = campaignId === '' || campaignId === 'new';
  const campaign = useQuery({
    queryKey: [...key, 'outreach', 'campaigns', 'one', campaignId],
    queryFn: () => getCampaign(campaignId),
    enabled: !isNew,
  });
  const out = campaign.data ?? null;
  const c = out?.campaign;
  const editable = isNew || c?.status === 'draft' || c?.status === 'paused';
  return (
    <>
      <PageHeader
        title={isNew ? t('leads.campaign.newTitle') : (c?.name ?? t('leads.campaign.title'))}
        actions={
          <Button asChild variant="outline">
            <Link to="/outreach">{t('leads.outreach.title')}</Link>
          </Button>
        }
      />
      <LockNotice settings={settings.data} />
      <Callout tone="info" title={t('leads.campaign.deliverability.title')}>
        {t('leads.campaign.deliverability.body')}
      </Callout>
      {isNew ? (
        settings.data !== undefined || settings.isError ? (
          <Card>
            <CardContent className="pt-6">
              <CampaignEditor out={null} />
            </CardContent>
          </Card>
        ) : null
      ) : (
        <QueryState query={campaign}>
          {out && c && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <CampaignStatusBadge status={c.status} />
                <span className="text-sm text-muted-foreground">{t('leads.campaign.revision', { revision: c.revision })}</span>
              </div>
              {c.status === 'awaiting_approval' && <ApprovalCard out={out} />}
              <RunControls out={out} />
              {editable && (
                <Card>
                  <CardHeader>
                    <CardTitle>{t('leads.campaign.editor')}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CampaignEditor key={`${c.id}:${c.revision}`} out={out} />
                  </CardContent>
                </Card>
              )}
              {c.status !== 'draft' && <Enrollments campaignId={c.id} />}
              {c.status !== 'draft' && (
                <Card>
                  <CardContent className="pt-6">
                    <Disclosure title={t('leads.report.campaignTab')}>
                      <CampaignReport campaignId={c.id} />
                    </Disclosure>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </QueryState>
      )}
    </>
  );
}
