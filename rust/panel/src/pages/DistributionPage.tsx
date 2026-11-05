import { useEffect, useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { backfill, getDistribution, listAssignments, setRep, setRules } from '@/api/distribution';
import {
  LEAD_SOURCE_KINDS,
  type AssignmentCursor,
  type AssignmentRow,
  type DistributionMethod,
  type DistributionMode,
  type DistributionOut,
  type Hours,
  type RepOut,
  type RuleInput,
  type RuleMatch,
} from '@/api/types';
import { useSession } from '@/auth/useSession';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  IconButton,
  Input,
  PageHeader,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatHour, weekdayName } from '@/lib/format';
import { useInFlight } from '@/lib/leads';
import { can } from '@/lib/roles';
import { selectClass } from './InboxShared';
import { HoursFields, ListInput, TeamTabs, parseList, useLeadsKey, useLeadsRefresh } from './LeadsShared';

/** A list typed as `a, b, c`. */
const listText = (items: string[]) => items.join(', ');
let keys = 0;
const newKey = () => `new-${++keys}`;

/** The editable form of the stored rules: what `distribution.rules_set` takes back. */
function draftOf(d: DistributionOut): RuleInput[] {
  return d.rules.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    when: r.when,
    to: r.to,
    method: r.method,
    sla_minutes: r.sla_minutes,
  }));
}

function emptyRule(): RuleInput {
  return {
    name: '',
    enabled: true,
    when: { sources: [], cities: [], sectors: [], languages: [], segments: [], min_score: null },
    to: { kind: 'all_eligible' },
    method: 'round_robin',
    sla_minutes: null,
  };
}

/** One rule of the editor: its match chips, pool, method and SLA. */
function RuleEditor({
  rule,
  index,
  count,
  reps,
  onChange,
  onMove,
  onRemove,
}: {
  rule: RuleInput;
  index: number;
  count: number;
  reps: RepOut[];
  onChange: (rule: RuleInput) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<RuleInput>) => onChange({ ...rule, ...patch });
  const when = (patch: Partial<RuleInput['when']>) => set({ when: { ...rule.when, ...patch } });
  const members = rule.to.kind === 'members' ? rule.to.user_ids : [];
  const label = rule.name || t('leads.distribution.rules.unnamed', { n: index + 1 });
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border p-3" data-testid="rule" aria-label={label}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption text-muted-foreground">{index + 1}.</span>
        <Input
          className="max-w-xs"
          aria-label={t('leads.distribution.rules.name')}
          value={rule.name}
          maxLength={80}
          onChange={(e) => set({ name: e.target.value })}
        />
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={rule.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {t('leads.distribution.rules.enabled')}
        </label>
        <div className="ms-auto flex gap-1">
          <IconButton
            aria-label={t('leads.distribution.rules.up', { name: label })}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label={t('leads.distribution.rules.down', { name: label })}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <IconButton aria-label={t('leads.distribution.rules.remove', { name: label })} onClick={onRemove}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <fieldset className="flex flex-wrap gap-2 text-sm">
        <legend className="mb-1 font-medium">{t('leads.distribution.rules.sources')}</legend>
        {LEAD_SOURCE_KINDS.map((s) => (
          <label key={s} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5">
            <input
              type="checkbox"
              checked={rule.when.sources.includes(s)}
              onChange={(e) =>
                when({ sources: e.target.checked ? [...rule.when.sources, s] : rule.when.sources.filter((x) => x !== s) })
              }
            />
            {t(`leads.sourceKinds.${s}`)}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {(['cities', 'sectors', 'languages', 'segments'] as const).map((k) => (
          <label key={k} className="flex flex-col gap-1 text-sm">
            {t(`leads.distribution.rules.${k}`)}
            <ListInput value={rule.when[k]} onChange={(items) => when({ [k]: items } as Partial<RuleMatch>)} />
          </label>
        ))}
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.distribution.rules.minScore')}
          <Input
            type="number"
            min={0}
            max={100}
            value={rule.when.min_score ?? ''}
            onChange={(e) => when({ min_score: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.distribution.rules.pool')}
          <select
            className={selectClass}
            value={rule.to.kind}
            onChange={(e) =>
              set({ to: e.target.value === 'members' ? { kind: 'members', user_ids: members } : { kind: 'all_eligible' } })
            }
          >
            <option value="all_eligible">{t('leads.distribution.rules.allEligible')}</option>
            <option value="members">{t('leads.distribution.rules.members')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.distribution.rules.method')}
          <select
            className={selectClass}
            value={rule.method}
            onChange={(e) => set({ method: e.target.value as DistributionMethod })}
          >
            <option value="round_robin">{t('leads.distribution.methods.round_robin')}</option>
            <option value="least_loaded">{t('leads.distribution.methods.least_loaded')}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.distribution.rules.sla')}
          <Input
            type="number"
            min={5}
            max={10080}
            value={rule.sla_minutes ?? ''}
            onChange={(e) => set({ sla_minutes: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
      </div>
      {rule.to.kind === 'members' && (
        <fieldset className="flex flex-wrap gap-2 text-sm">
          <legend className="mb-1 font-medium">{t('leads.distribution.rules.members')}</legend>
          {reps.map((r) => (
            <label key={r.user_id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={members.includes(r.user_id)}
                onChange={(e) =>
                  set({
                    to: {
                      kind: 'members',
                      user_ids: e.target.checked ? [...members, r.user_id] : members.filter((x) => x !== r.user_id),
                    },
                  })
                }
              />
              {r.display_name ?? r.user_id}
            </label>
          ))}
        </fieldset>
      )}
    </li>
  );
}

/** The ordered rules, the mode and the reassignment limit, saved whole (`inbox.manage`). */
function RulesCard({ data }: { data: DistributionOut }) {
  const { t } = useTranslation();
  const session = useSession();
  const manage = can(session.data, 'inbox.manage');
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  // Each rule carries a key of its own while edited, so moving one moves its fields with it.
  const [items, setItems] = useState(() => draftOf(data).map((rule) => ({ key: rule.id ?? newKey(), rule })));
  const rules = items.map((x) => x.rule);
  const [mode, setMode] = useState<DistributionMode>(data.mode);
  const [maxReassign, setMaxReassign] = useState(String(data.max_reassignments));
  const save = useMutation({
    mutationFn: () => setRules({ rules, mode, max_reassignments: Number(maxReassign) }),
    onSuccess: async () => {
      toast.success(t('leads.distribution.rules.saved'));
      await refresh();
    },
  });
  const move = (i: number, by: -1 | 1) =>
    setItems((xs) => {
      const next = [...xs];
      [next[i], next[i + by]] = [next[i + by], next[i]];
      return next;
    });
  const valid =
    rules.every((r) => r.name.trim() && (r.to.kind === 'all_eligible' || r.to.user_ids.length > 0)) &&
    /^\d+$/.test(maxReassign) &&
    Number(maxReassign) <= 10;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => save.mutate(undefined, { onSettled: release }));
  };
  const ruleName = (id: string | null) => data.rules.find((r) => r.id === id)?.name;
  if (!manage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('leads.distribution.rules.title')}</CardTitle>
          <CardDescription>{t(`leads.distribution.modes.${data.mode}`)}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('leads.distribution.rules.none')}</p>
          ) : (
            <ol className="flex flex-col gap-1 text-sm" aria-label={t('leads.distribution.rules.title')}>
              {data.rules.map((r) => (
                <li key={r.id}>
                  {ruleName(r.id)} · {t(`leads.distribution.methods.${r.method}`)}
                  {!r.enabled && ` · ${t('leads.distribution.rules.off')}`}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('leads.distribution.rules.title')}</CardTitle>
        <CardDescription>{t('leads.distribution.rules.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={submit} aria-label={t('leads.distribution.rules.title')}>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.distribution.mode')}
              <select className={selectClass} value={mode} onChange={(e) => setMode(e.target.value as DistributionMode)}>
                <option value="auto">{t('leads.distribution.modes.auto')}</option>
                <option value="manual">{t('leads.distribution.modes.manual')}</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              {t('leads.distribution.maxReassignments')}
              <Input type="number" min={0} max={10} value={maxReassign} onChange={(e) => setMaxReassign(e.target.value)} />
            </label>
          </div>
          <ol className="flex flex-col gap-2" aria-label={t('leads.distribution.rules.list')}>
            {items.map(({ key, rule: r }, i) => (
              <RuleEditor
                key={key}
                rule={r}
                index={i}
                count={rules.length}
                reps={data.reps}
                onChange={(next) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, rule: next } : x)))}
                onMove={(by) => move(i, by)}
                onRemove={() => setItems((xs) => xs.filter((_, j) => j !== i))}
              />
            ))}
          </ol>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={() => setItems((xs) => [...xs, { key: newKey(), rule: emptyRule() }])}>
              {t('leads.distribution.rules.add')}
            </Button>
          </div>
          <ErrorCallout error={save.error} />
          <div>
            <Button type="submit" disabled={!valid} loading={save.isPending}>
              {t('leads.distribution.rules.save')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** How a member's working hours read. */
function hoursText(t: TFunction, language: string, h: Hours | null): string {
  if (!h) return t('leads.distribution.reps.anyTime');
  return `${h.days.map((d) => weekdayName(d, language)).join(' ')} ${formatHour(h.from)}–${formatHour(h.to)} (${h.tz})`;
}

/**
 * One member's availability, edited whole (`distribution.rep_set` replaces the profile). Keyed by
 * the member, so a draft never moves to another one's row.
 */
function RepEditor({ rep, onClose }: { rep: RepOut; onClose: () => void }) {
  const { t } = useTranslation();
  const refresh = useLeadsRefresh();
  const guard = useInFlight();
  const p = rep.profile;
  const [accepting, setAccepting] = useState(p.accepting);
  const [maxOpen, setMaxOpen] = useState(p.max_open == null ? '' : String(p.max_open));
  const [languages, setLanguages] = useState(listText(p.languages));
  const [cities, setCities] = useState(listText(p.cities));
  const [sectors, setSectors] = useState(listText(p.sectors));
  const [hours, setHours] = useState<Hours | null>(p.hours);
  const [away, setAway] = useState(p.away_until ? p.away_until.slice(0, 16) : '');
  const save = useMutation({
    mutationFn: () =>
      setRep(rep.user_id, {
        accepting,
        max_open: maxOpen === '' ? null : Number(maxOpen),
        languages: parseList(languages),
        cities: parseList(cities),
        sectors: parseList(sectors),
        hours,
        away_until: away ? new Date(away).toISOString() : null,
      }),
    onSuccess: async () => {
      toast.success(t('leads.distribution.reps.saved'));
      onClose();
      await refresh();
    },
  });
  const valid = maxOpen === '' || (/^\d+$/.test(maxOpen) && Number(maxOpen) >= 1 && Number(maxOpen) <= 10000);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    guard((release) => save.mutate(undefined, { onSettled: release }));
  };
  const name = rep.display_name ?? rep.user_id;
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={submit}
      aria-label={t('leads.distribution.reps.editTitle', { name })}
    >
      <h3 className="text-sm font-medium">{t('leads.distribution.reps.editTitle', { name })}</h3>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={accepting} onChange={(e) => setAccepting(e.target.checked)} />
        {t('leads.distribution.reps.accepting')}
      </label>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.distribution.reps.maxOpen')}
          <Input type="number" min={1} max={10000} value={maxOpen} onChange={(e) => setMaxOpen(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.distribution.reps.languages')}
          <Input value={languages} onChange={(e) => setLanguages(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.distribution.reps.cities')}
          <Input value={cities} onChange={(e) => setCities(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('leads.distribution.reps.sectors')}
          <Input value={sectors} onChange={(e) => setSectors(e.target.value)} />
        </label>
      </div>
      <HoursFields value={hours} onChange={setHours} optional label={t('leads.distribution.reps.hours')} />
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        {t('leads.distribution.reps.awayUntil')}
        <Input type="datetime-local" value={away} onChange={(e) => setAway(e.target.value)} />
      </label>
      <ErrorCallout error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!valid} loading={save.isPending}>
          {t('common.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={save.isPending} onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The members' availability; one's own row is editable, every row with `inbox.manage`. */
function RepsCard({ data }: { data: DistributionOut }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const manage = can(session.data, 'inbox.manage');
  const [editing, setEditing] = useState<string | null>(null);
  const editable = (r: RepOut) => manage || r.user_id === session.data?.user_id;
  const current = data.reps.find((r) => r.user_id === editing);
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{t('leads.distribution.reps.title')}</CardTitle>
        <CardDescription>{t('leads.distribution.reps.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <p className="text-caption text-muted-foreground sm:hidden">{t('leads.distribution.reps.scrollHint')}</p>
        <div className="relative w-full min-w-0 overflow-x-auto">
          <table className="w-full min-w-[48rem] text-left text-sm" aria-label={t('leads.distribution.reps.title')}>
            <thead className="text-caption text-muted-foreground">
              <tr>
                <th className="py-1 pe-3 font-normal">{t('leads.distribution.reps.member')}</th>
                <th className="py-1 pe-3 font-normal">{t('leads.distribution.reps.state')}</th>
                <th className="py-1 pe-3 font-normal">{t('leads.distribution.reps.load')}</th>
                <th className="py-1 pe-3 font-normal">{t('leads.distribution.reps.filters')}</th>
                <th className="py-1 pe-3 font-normal">{t('leads.distribution.reps.hours')}</th>
                <th className="py-1 font-normal">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.reps.map((r) => (
                <tr key={r.user_id} className="border-t border-border align-top hover:bg-surface-muted/40" data-testid="rep">
                  <td className="py-2 pe-3">
                    <span className="font-medium">{r.display_name ?? r.user_id}</span>
                    {r.on_shift && <Badge tone="success" className="ms-2">{t('leads.distribution.reps.onShift')}</Badge>}
                  </td>
                  <td className="py-2 pe-3">
                    {r.eligible ? (
                      <Badge tone="success">{t('leads.distribution.reps.eligible')}</Badge>
                    ) : (
                      <Badge tone="neutral">{t('leads.distribution.reps.notEligible')}</Badge>
                    )}
                    {!r.profile.accepting && <span className="block text-caption">{t('leads.distribution.reps.paused')}</span>}
                    {r.profile.away_until && new Date(r.profile.away_until).getTime() > Date.now() && (
                      <span className="block text-caption">
                        {t('leads.distribution.reps.awayTill', { at: formatDateTime(r.profile.away_until, i18n.language) })}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pe-3 tabular-nums">
                    {r.profile.max_open == null
                      ? t('leads.distribution.reps.loadOpen', { open: r.open_owned })
                      : t('leads.distribution.reps.loadOf', { open: r.open_owned, max: r.profile.max_open })}
                  </td>
                  <td className="py-2 pe-3">
                    {[...r.profile.languages, ...r.profile.cities, ...r.profile.sectors].join(', ') || '—'}
                  </td>
                  <td className="py-2 pe-3">{hoursText(t, i18n.language, r.profile.hours)}</td>
                  <td className="py-2 text-end">
                    {editable(r) && (
                      <Button size="sm" variant="ghost" onClick={() => setEditing(r.user_id)}>
                        {t('leads.distribution.reps.edit', { name: r.display_name ?? r.user_id })}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {current && <RepEditor key={current.user_id} rep={current} onClose={() => setEditing(null)} />}
      </CardContent>
    </Card>
  );
}

/** The ownerless and stalled counts, and the manager's backfill. */
function CountsCard({ data }: { data: DistributionOut }) {
  const { t } = useTranslation();
  const session = useSession();
  const manage = can(session.data, 'inbox.manage');
  const refresh = useLeadsRefresh();
  const [last, setLast] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () => backfill({}),
    onSuccess: async (out) => {
      setLast(t('leads.distribution.backfillDone', { ...out }));
      await refresh();
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-wrap gap-x-10 gap-y-4 border-y border-border py-4">
        <div><dt className="text-sm text-muted-foreground">{t('leads.distribution.ownerless')}</dt><dd className="mt-1 text-2xl font-medium tabular-nums">{data.ownerless.count}</dd></div>
        <div><dt className="text-sm text-muted-foreground">{t('leads.distribution.stalled')}</dt><dd className="mt-1 text-2xl font-medium tabular-nums">{data.stalled}</dd></div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        {manage && (
          <Button loading={run.isPending} onClick={() => !run.isPending && run.mutate()}>
            {t('leads.distribution.backfill')}
          </Button>
        )}
        {last && (
          <p role="status" className="text-sm">
            {last}
          </p>
        )}
      </div>
    </div>
  );
}

/** The assignment log, newest first, by member, a page at a time. */
function AssignmentLog({ data }: { data: DistributionOut }) {
  const { t, i18n } = useTranslation();
  const key = useLeadsKey();
  const [member, setMember] = useState('');
  const [cursors, setCursors] = useState<AssignmentCursor[]>([]);
  useEffect(() => setCursors([]), [member]);
  const page = cursors.at(-1);
  const query = { user_id: member || undefined, limit: 50, before_at: page?.assigned_at, before_id: page?.id };
  const log = useQuery({
    queryKey: [...key, 'distribution', 'assignments', query],
    queryFn: () => listAssignments(query),
    placeholderData: keepPreviousData,
  });
  const name = (id: string | null) =>
    id ? (data.reps.find((r) => r.user_id === id)?.display_name ?? t('leads.recorder.member')) : '—';
  const ruleName = (id: string | null) => (id ? data.rules.find((r) => r.id === id)?.name : null);
  const items: AssignmentRow[] = log.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('leads.distribution.log.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex max-w-xs flex-col gap-1 text-sm">
          {t('leads.distribution.log.member')}
          <select className={selectClass} value={member} onChange={(e) => setMember(e.target.value)}>
            <option value="">{t('leads.prospects.filters.all')}</option>
            {data.reps.map((r) => (
              <option key={r.user_id} value={r.user_id}>
                {r.display_name ?? r.user_id}
              </option>
            ))}
          </select>
        </label>
        <QueryState query={log}>
          {items.length === 0 ? (
            <EmptyState title={t('leads.distribution.log.empty')} />
          ) : (
            <ol className="flex flex-col divide-y divide-border text-sm" aria-label={t('leads.distribution.log.title')}>
              {items.map((a) => (
                <li key={a.id} className="flex flex-wrap items-baseline gap-2 py-2" data-testid="assignment">
                  <span className="text-muted-foreground">{formatDateTime(a.assigned_at, i18n.language)}</span>
                  <span className="font-medium">{name(a.user_id)}</span>
                  <Badge tone={a.cause === 'no_eligible' ? 'warning' : 'neutral'}>{t(`leads.causes.${a.cause}`)}</Badge>
                  {ruleName(a.rule_id) && <span>{ruleName(a.rule_id)}</span>}
                  {a.sla_due_at && !a.acted_at && !a.superseded_at && (
                    <span className="text-caption">
                      {t('leads.distribution.log.slaDue', { at: formatDateTime(a.sla_due_at, i18n.language) })}
                    </span>
                  )}
                  {a.acted_at && (
                    <span className="text-caption">
                      {t('leads.distribution.log.acted', { at: formatDateTime(a.acted_at, i18n.language) })}
                    </span>
                  )}
                  {a.superseded_at && <span className="text-caption text-muted-foreground">{t('leads.distribution.log.superseded')}</span>}
                </li>
              ))}
            </ol>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={cursors.length === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              {t('leads.prospects.previous')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!log.data?.next}
              onClick={() => {
                const next = log.data?.next;
                if (next) setCursors((c) => [...c, next]);
              }}
            >
              {t('leads.prospects.next')}
            </Button>
          </div>
        </QueryState>
      </CardContent>
    </Card>
  );
}

/** `/team/distribution` (a tab of Team): who owns new journeys, and the log (spec §9). */
export function DistributionPage() {
  const { t } = useTranslation();
  const key = useLeadsKey();
  const dist = useQuery({ queryKey: [...key, 'distribution'], queryFn: getDistribution });
  return (
    <>
      <PageHeader title={t('leads.distribution.title')} description={t('leads.distribution.description')} />
      <TeamTabs />
      <QueryState query={dist}>
        {dist.data && (
          <div className="flex min-w-0 flex-col gap-4">
            <CountsCard data={dist.data} />
            {/* A new draft only when the stored rules change, never on a mere refetch. */}
            <RulesCard
              key={JSON.stringify([dist.data.mode, dist.data.max_reassignments, dist.data.rules])}
              data={dist.data}
            />
            <RepsCard data={dist.data} />
            <AssignmentLog data={dist.data} />
          </div>
        )}
      </QueryState>
    </>
  );
}
