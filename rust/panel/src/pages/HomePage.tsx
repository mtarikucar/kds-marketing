import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, ChevronDown, Pencil, Play } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { getStrategy, startConsultation } from '@/api/strategy';
import {
  INBOUND_EVENTS_COUNT_CAP,
  MAX_CHECKIN_INTERVAL_MINUTES,
  MIN_CHECKIN_INTERVAL_MINUTES,
  type AgentState,
  type PendingOut,
  type StrategyState,
  type WorkItem,
} from '@/api/types';
import { getPending, setCheckinInterval } from '@/api/work';
import { getWorkspace } from '@/api/workspace';
import { useSession } from '@/auth/useSession';
import { ApproveDialog } from '@/components/ApproveDialog';
import { ErrorCallout } from '@/components/ErrorCallout';
import { GapList } from '@/components/GapList';
import { PermissionList } from '@/components/PermissionList';
import { QueryState } from '@/components/QueryState';
import { WorkspaceStatusBadge } from '@/components/StatusBadges';
import { WholeNumberInput } from '@/components/forms';
import {
  Badge,
  Button,
  Callout,
  Field,
  PageHeader,
  toast,
} from '@/components/ui';
import { formatDateTime, formatRelative } from '@/lib/format';
import { can, canApproveStrategy, roleLabel } from '@/lib/roles';
import { PENDING_KEY, STRATEGY_KEY, invalidateStrategy } from './strategy/queries';

/** How many of a draft's gaps the home page lists before "and N more". */
const GAPS_SHOWN = 5;

/** An interval in minutes as `24 sa`, `1 sa 30 dk` or `45 dk`. */
function durationLabel(t: TFunction, minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(t('home.agent.hours', { count: hours }));
  if (rest > 0 || hours === 0) parts.push(t('home.agent.minutes', { count: rest }));
  return parts.join(' ');
}

function OpenStrategy() {
  const { t } = useTranslation();
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/strategy">{t('home.strategy.open')}</Link>
    </Button>
  );
}

/** Where the strategy stands, with the one step that moves it on for this user. */
function StrategyCard({ state }: { state: StrategyState }) {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canConsult = can(session.data, 'team.manage');
  const canApprove = canApproveStrategy(session.data);
  const approvedNumber = typeof state === 'object' && 'approved' in state ? state.approved.number : null;
  const submitted = typeof state === 'object' && 'submitted' in state;
  const [approving, setApproving] = useState(false);
  // To count the hypotheses in force, and to list what a submitted draft rests on before it is
  // approved: fetched again when the approval opens, and shown only once fetched.
  const strategy = useQuery({
    queryKey: STRATEGY_KEY,
    queryFn: getStrategy,
    enabled: approvedNumber !== null || approving,
  });
  const openApproval = () => {
    setApproving(true);
    void strategy.refetch();
  };

  const start = useMutation({
    mutationFn: startConsultation,
    onSuccess: async () => {
      toast.success(t('strategy.started'));
      await invalidateStrategy(queryClient);
      navigate('/strategy');
    },
  });

  let title: string;
  let body: ReactNode;
  let actions: ReactNode;
  if (state === 'missing') {
    title = t('home.strategy.title');
    body = <p>{t('home.strategy.body')}</p>;
    actions = canConsult ? (
      <Button size="sm" onClick={() => start.mutate()} loading={start.isPending}>
        <Play className="h-4 w-4" aria-hidden="true" />
        {t('home.strategy.start')}
      </Button>
    ) : (
      <OpenStrategy />
    );
  } else if ('submitted' in state) {
    title = t('home.strategy.submittedTitle');
    body = canApprove ? null : <p>{t('home.strategy.submittedWait')}</p>;
    actions = (
      <>
        {canApprove && (
          <Button size="sm" onClick={openApproval}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {t('home.strategy.approve')}
          </Button>
        )}
        <OpenStrategy />
      </>
    );
  } else if ('draft_open' in state) {
    const { gaps } = state.draft_open;
    title = t('home.strategy.draftTitle');
    body =
      gaps.length === 0 ? (
        <p>{t('home.strategy.noGaps')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p>{t('home.strategy.draftBody', { count: gaps.length })}</p>
          <GapList gaps={gaps.slice(0, GAPS_SHOWN)} />
          {gaps.length > GAPS_SHOWN && (
            <p className="text-caption text-muted-foreground">
              {t('home.strategy.moreGaps', { count: gaps.length - GAPS_SHOWN })}
            </p>
          )}
        </div>
      );
    actions = <OpenStrategy />;
  } else {
    const live = strategy.data?.approved?.hypotheses.filter((h) => h.state !== 'retired').length;
    title = t('home.strategy.approvedTitle');
    body = (
      <div className="flex flex-col gap-1">
        <p>{t('home.strategy.approvedBody', { number: state.approved.number })}</p>
        {live !== undefined && <p className="text-muted-foreground">{t('home.strategy.hypotheses', { count: live })}</p>}
      </div>
    );
    actions = <OpenStrategy />;
  }

  return (
    <section aria-labelledby="home-strategy" className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t('home.strategy.label')}</p>
        <h2 id="home-strategy" className="text-lg font-semibold leading-snug tracking-tight text-foreground">{title}</h2>
      </div>
      <div className="flex flex-1 flex-col gap-4 text-sm leading-relaxed text-muted-foreground">
        {body}
        <ErrorCallout error={start.error} />
        <div className="mt-auto flex flex-wrap gap-2">{actions}</div>
      </div>
      {submitted && canApprove && (
        // The shortcut approves the draft the dialog shows, fetched when it opens (never the
        // pending work's stamp, which may be older), and lists what it rests on.
        <ApproveDialog
          open={approving}
          onOpenChange={setApproving}
          draft={strategy.data && !strategy.isFetching ? strategy.data.draft : undefined}
        />
      )}
    </section>
  );
}

/** The agent's check-in: when it was last seen, how often it should be, and a red warning when late. */
function AgentCard({ agent }: { agent: AgentState }) {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const queryClient = useQueryClient();
  const canEdit = can(session.data, 'team.manage');
  const [editing, setEditing] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: setCheckinInterval,
    onSuccess: (next) => {
      setEditing(null);
      toast.success(t('home.agent.intervalSaved'));
      queryClient.setQueryData<PendingOut>(PENDING_KEY, (old) => (old ? { ...old, agent: next } : old));
    },
  });
  const valid =
    editing !== null && editing >= MIN_CHECKIN_INTERVAL_MINUTES && editing <= MAX_CHECKIN_INTERVAL_MINUTES;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate(editing);
  };

  return (
    <section aria-labelledby="home-agent" className="flex flex-col gap-4 border-t border-border pt-6">
      <h2 id="home-agent" className="text-lg font-semibold tracking-tight text-foreground">{t('home.agent.title')}</h2>
      <div className="flex flex-col gap-4 text-sm leading-relaxed">
        {!agent.last_seen_at ? (
          // Never connected is a setup step, not an incident.
          <div>
            <p className="mb-1 font-medium text-foreground">{t('home.agent.neverTitle')}</p>
            <p className="text-muted-foreground">{t('home.agent.never')}</p>
            <Link className="mt-1 inline-block text-primary underline" to="/api-keys">
              {t('home.agent.connectLink')}
            </Link>
          </div>
        ) : agent.overdue ? (
          <Callout tone="danger" title={t('home.agent.overdueTitle')}>
            <p>{t('home.agent.overdueBody')}</p>
            <p className="mt-1">{t('home.agent.schedulerNote')}</p>
          </Callout>
        ) : (
          <p className="flex items-start gap-2 text-foreground">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            {t('home.agent.onTime')}
          </p>
        )}
        <dl className="grid gap-4">
          <div className="flex flex-col gap-0.5">
            <dt className="text-caption text-muted-foreground">{t('home.agent.lastSeen')}</dt>
            <dd className="text-foreground">
              {agent.last_seen_at ? (
                <time dateTime={agent.last_seen_at} title={formatDateTime(agent.last_seen_at, i18n.language)}>
                  {formatRelative(agent.last_seen_at, i18n.language)}
                </time>
              ) : (
                t('common.none')
              )}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-caption text-muted-foreground">{t('home.agent.interval')}</dt>
            <dd className="flex items-center gap-2 text-foreground">
              {durationLabel(t, agent.interval_minutes)}
              {canEdit && editing === null && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(agent.interval_minutes)}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('home.agent.editInterval')}
                </Button>
              )}
            </dd>
          </div>
        </dl>
        {editing !== null && (
          <form className="flex flex-col gap-3" onSubmit={onSubmit} noValidate>
            <Field label={t('home.agent.intervalLabel')} hint={t('home.agent.intervalHint')} className="sm:flex-1">
              {(ids) => (
                <WholeNumberInput
                  id={ids.id}
                  describedBy={ids.describedBy}
                  min={MIN_CHECKIN_INTERVAL_MINUTES}
                  max={MAX_CHECKIN_INTERVAL_MINUTES}
                  value={editing}
                  onChange={(n) => setEditing(n ?? 0)}
                />
              )}
            </Field>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditing(null);
                  save.reset();
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={save.isPending} disabled={!valid}>
                {t('common.save')}
              </Button>
            </div>
          </form>
        )}
        <ErrorCallout error={save.error} />
        {!agent.overdue && <p className="text-caption text-muted-foreground">{t('home.agent.schedulerNote')}</p>}
      </div>
    </section>
  );
}

function itemText(t: TFunction, item: WorkItem): string {
  switch (item.kind) {
    case 'verify_capability':
      return item.stale
        ? t('home.pending.verify_capability_stale', { name: item.name })
        : t('home.pending.verify_capability', { name: item.name });
    case 'connect_connector':
      return t('home.pending.connect_connector', { name: item.name });
    case 'reconnect_connector':
      return t('home.pending.reconnect_connector', { name: item.name });
    case 'voice_bridge_offline':
      return t('home.pending.voice_bridge_offline', { name: item.name });
    case 'phone_offline':
      return t('home.pending.phone_offline', { name: item.name });
    case 'inbound_events':
      // `count` picks the plural form; `n` is what is shown, a count of the cap as at least that many.
      return t('home.pending.inbound_events', {
        count: item.count,
        n: item.count >= INBOUND_EVENTS_COUNT_CAP ? `${INBOUND_EVENTS_COUNT_CAP}+` : String(item.count),
      });
    default:
      return t(`home.pending.${item.kind}`);
  }
}

/**
 * Where an item is acted on: a capability to reconnect goes straight to its reconnection; the
 * inbound events are the agent's to read and acknowledge, so nothing opens for them.
 */
function itemLink(item: WorkItem): string | null {
  switch (item.kind) {
    case 'reply_due':
    case 'reopen_question':
      return `/inbox/${encodeURIComponent(item.conversation_id)}`;
    case 'merge_suggested':
      return `/inbox/merges?merge=${encodeURIComponent(item.merge_id)}`;
    case 'task_due':
      return `/inbox?task=${encodeURIComponent(item.task_id)}`;
    case 'consult_strategy':
    case 'approve_strategy':
      return '/strategy';
    case 'reconnect_connector':
      return `/connect?capability=${encodeURIComponent(item.capability_id)}`;
    case 'research_due':
      return '/prospects/tasks';
    case 'prospects_to_score':
    case 'prospects_to_promote':
      return '/prospects';
    case 'ownerless_journeys':
    case 'assignment_stalled':
      return '/team/distribution';
    case 'promoted_not_contacted':
      return '/inbox';
    case 'campaign_approval':
    case 'campaign_blocked':
    case 'personalization_due':
      return `/outreach/${encodeURIComponent(item.campaign_id)}`;
    case 'inbound_events':
      return null;
    default:
      return '/capabilities';
  }
}

/** The pending items, most urgent first, each in the panel's own words (the hints are for the agent). */
function PendingList({ items }: { items: readonly WorkItem[] }) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="home-pending">
      <div className="flex items-baseline justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 id="home-pending" className="text-xl font-semibold tracking-tight text-foreground">{t('home.pending.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('home.pending.description')}</p>
        </div>
        <span className="text-2xl font-medium tabular-nums text-foreground" aria-label={t('home.pending.count', { count: items.length })}>
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="flex flex-col items-start gap-4 py-8 sm:flex-row sm:items-center sm:gap-6">
          <img
            src="/brand/work-complete.svg"
            alt=""
            aria-hidden="true"
            width={112}
            height={112}
            className="h-24 w-24 shrink-0 sm:h-28 sm:w-28"
          />
          <div>
            <p className="font-medium text-foreground">{t('home.pending.empty')}</p>
            <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">{t('home.pending.emptyHint')}</p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item, i) => {
            const link = itemLink(item);
            return (
              <li
                key={`${item.kind}-${'capability_id' in item ? item.capability_id : i}`}
                className="flex items-start gap-3 py-5 sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed text-foreground">{itemText(t, item)}</p>
                  <div className="mt-2">
                    <Badge tone={item.priority === 1 ? 'warning' : 'neutral'} size="sm">
                      {t('home.pending.priority', { priority: item.priority })}
                    </Badge>
                  </div>
                </div>
                {link && (
                  <Button asChild variant="ghost" size="sm" className="shrink-0">
                    <Link to={link}>
                      {item.kind === 'reconnect_connector' ? t('home.pending.reconnect') : t('home.pending.open')}
                      <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden="true" />
                    </Link>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <nav aria-label={t('home.continueWorking')} className="mt-5 grid border-t border-border sm:grid-cols-2">
        <Link to="/inbox" className="group flex items-start justify-between gap-4 py-5 sm:pe-6">
          <div>
            <p className="text-sm font-medium text-foreground group-hover:text-primary">{t('nav.inbox')}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('home.inboxHint')}</p>
          </div>
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
        </Link>
        <Link to="/studio" className="group flex items-start justify-between gap-4 border-t border-border py-5 sm:border-s sm:border-t-0 sm:ps-6">
          <div>
            <p className="text-sm font-medium text-foreground group-hover:text-primary">{t('nav.studio')}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('home.studioHint')}</p>
          </div>
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden="true" />
        </Link>
      </nav>
    </section>
  );
}

export function HomePage() {
  const { t } = useTranslation();
  const session = useSession();
  const workspace = useQuery({
    queryKey: ['workspace', session.data?.current_workspace],
    queryFn: getWorkspace,
    enabled: !!session.data?.current_workspace,
  });
  const pending = useQuery({
    queryKey: PENDING_KEY,
    queryFn: getPending,
    enabled: !!session.data?.current_workspace,
  });

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        title={t('home.title')}
        description={t('home.description')}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to="/onboarding">{t('onboarding.title')}<ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden="true" /></Link>
          </Button>
        }
      />
      <QueryState query={workspace}>
        {workspace.data && (
          <section aria-labelledby="home-workspace" className="border-y border-border py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <h2 id="home-workspace" className="text-base font-semibold text-foreground">{workspace.data.name}</h2>
                <WorkspaceStatusBadge status={workspace.data.status} />
              </div>
              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <span>{t('home.myRole')}: {roleLabel(t, workspace.data.my_role)}</span>
                <Link className="underline underline-offset-4 hover:text-foreground" to="/billing">{t('billing.title')}</Link>
              </div>
            </div>
            {workspace.data.status !== 'active' && (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(`home.inactive.${workspace.data.status}`)}</p>
            )}
            <details className="group mt-3 text-xs text-muted-foreground">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
                {t('home.workspaceDetails')}
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <dl className="mt-4 grid gap-4 pb-1 sm:grid-cols-[1fr_3fr]">
                <div>
                  <dt className="mb-1">{t('home.slug')}</dt>
                  <dd className="font-mono text-foreground">{workspace.data.slug}</dd>
                </div>
                <div>
                  <dt className="mb-2">{t('home.myPermissions')}</dt>
                  <dd><PermissionList permissions={workspace.data.my_permissions} /></dd>
                </div>
              </dl>
            </details>
          </section>
        )}
      </QueryState>
      <QueryState query={pending}>
        {pending.data && (
          <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_20rem] xl:gap-10">
            <div className="min-w-0"><PendingList items={pending.data.items} /></div>
            <aside className="flex min-w-0 flex-col gap-7 border-t border-border pt-6 xl:border-s xl:border-t-0 xl:ps-8 xl:pt-0">
              <StrategyCard state={pending.data.strategy} />
              <AgentCard agent={pending.data.agent} />
            </aside>
          </div>
        )}
      </QueryState>
    </div>
  );
}
