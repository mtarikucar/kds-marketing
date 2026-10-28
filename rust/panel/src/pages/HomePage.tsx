import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, CheckCircle2, Compass, ListTodo, Pencil, Play } from 'lucide-react';
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
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center gap-2">
        <Compass className="h-5 w-5 text-primary" aria-hidden="true" />
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 text-sm text-foreground">
        {body}
        <ErrorCallout error={start.error} />
        <div className="mt-auto flex flex-wrap gap-2">{actions}</div>
      </CardContent>
      {submitted && canApprove && (
        // The shortcut approves the draft the dialog shows, fetched when it opens (never the
        // pending work's stamp, which may be older), and lists what it rests on.
        <ApproveDialog
          open={approving}
          onOpenChange={setApproving}
          draft={strategy.data && !strategy.isFetching ? strategy.data.draft : undefined}
        />
      )}
    </Card>
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
    <Card className="flex flex-col">
      <CardHeader className="flex-row items-center gap-2">
        <Bot className="h-5 w-5 text-primary" aria-hidden="true" />
        <CardTitle>{t('home.agent.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {!agent.last_seen_at ? (
          // Never connected is a setup step, not an incident.
          <Callout tone="info" title={t('home.agent.neverTitle')}>
            <p>{t('home.agent.never')}</p>
            <Link className="mt-1 inline-block text-primary underline" to="/api-keys">
              {t('home.agent.connectLink')}
            </Link>
          </Callout>
        ) : agent.overdue ? (
          <Callout tone="danger" title={t('home.agent.overdueTitle')}>
            <p>{t('home.agent.overdueBody')}</p>
            <p className="mt-1">{t('home.agent.schedulerNote')}</p>
          </Callout>
        ) : (
          <Callout tone="success">{t('home.agent.onTime')}</Callout>
        )}
        <dl className="grid gap-3 sm:grid-cols-2">
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
          <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={onSubmit} noValidate>
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
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <ListTodo className="h-5 w-5 text-primary" aria-hidden="true" />
        <CardTitle>{t('home.pending.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('home.pending.empty')}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {items.map((item, i) => {
              const link = itemLink(item);
              return (
                <li
                  key={`${item.kind}-${'capability_id' in item ? item.capability_id : i}`}
                  className="flex items-center gap-3 py-2.5"
                >
                  <Badge tone={item.priority === 1 ? 'warning' : 'neutral'} size="sm">
                    {t('home.pending.priority', { priority: item.priority })}
                  </Badge>
                  <span className="min-w-0 flex-1 text-sm text-foreground">{itemText(t, item)}</span>
                  {link && (
                    <Button asChild variant="ghost" size="sm">
                      <Link to={link}>
                        {item.kind === 'reconnect_connector' ? t('home.pending.reconnect') : t('home.pending.open')}
                      </Link>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
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
    <>
      <PageHeader title={t('home.title')} description={t('home.description')} />
      <div className="flex gap-4"><Link className="text-primary underline" to="/onboarding">{t('onboarding.title')}</Link><Link className="text-primary underline" to="/billing">{t('billing.title')}</Link></div>
      <QueryState query={workspace}>
        {workspace.data && (
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle>{workspace.data.name}</CardTitle>
                <CardDescription>{t(`home.inactive.${workspace.data.status}`)}</CardDescription>
              </div>
              <WorkspaceStatusBadge status={workspace.data.status} />
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <dt className="text-caption text-muted-foreground">{t('home.slug')}</dt>
                  <dd className="font-mono text-foreground">{workspace.data.slug}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-caption text-muted-foreground">{t('home.myRole')}</dt>
                  <dd className="text-foreground">{roleLabel(t, workspace.data.my_role)}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-caption text-muted-foreground">{t('home.myPermissions')}</dt>
                  <dd>
                    <PermissionList permissions={workspace.data.my_permissions} />
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        )}
      </QueryState>
      <QueryState query={pending}>
        {pending.data && (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <StrategyCard state={pending.data.strategy} />
              <AgentCard agent={pending.data.agent} />
            </div>
            <PendingList items={pending.data.items} />
          </>
        )}
      </QueryState>
    </>
  );
}
