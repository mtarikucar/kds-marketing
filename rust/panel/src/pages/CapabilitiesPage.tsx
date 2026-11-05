import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { listBudgetItems } from '@/api/budget';
import { listCapabilities, listGroups, retireCapability, unlinkBudget } from '@/api/capabilities';
import { connectorHealth, probeConnector, reconnectConnector } from '@/api/connectors';
import { KIND_GROUPS, type CapabilityOut, type KindGroup, type ProbeOut } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { CapabilityCard, type CapabilityAction, type ConnectorAction } from '@/components/CapabilityCard';
import { QueryState } from '@/components/QueryState';
import { CapabilityStatusBadge } from '@/components/StatusBadges';
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Disclosure,
  Input,
  EmptyState,
  PageHeader,
  cn,
  toast,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui';
import {
  CAPABILITY_GOALS,
  matchesGoal,
  needsCapabilityAttention,
  type CapabilityGoal,
} from '@/lib/capabilityGoals';
import { kindLabel } from '@/lib/capabilities';
import { PurposePanel } from './capabilities/PurposePanel';
import { browser, providerUrl } from '@/lib/browser';
import { connectsByOAuth, isErrorKind, providerOf } from '@/lib/connectors';
import { errorMessage } from '@/lib/errors';
import { rememberStart } from '@/lib/oauthFlow';
import { can } from '@/lib/roles';
import {
  DeclareDialog,
  EditDialog,
  LinkBudgetDialog,
  PolicyDialog,
  UnreachableDialog,
  VerifyDialog,
} from './capabilities/dialogs';
import { GroupsPanel } from './capabilities/GroupsPanel';
import { PairBridgePanel } from './capabilities/PhoneCard';
import { WebhookPanel } from './capabilities/WebhookPanel';
import {
  BUDGET_ITEMS_KEY,
  CAPABILITIES_KEY,
  CONNECTOR_HEALTH_KEY,
  GROUPS_KEY,
  PHONE_REFRESH_MS,
  invalidateCapabilities,
} from './capabilities/queries';

type Filter = KindGroup | 'all';

function FilterChips({ value, onChange }: { value: Filter; onChange: (next: Filter) => void }) {
  const { t } = useTranslation();
  const options: Filter[] = ['all', ...KIND_GROUPS];
  return (
    <div role="group" aria-label={t('capabilities.filterLabel')} className="flex flex-wrap gap-2">
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-caption font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-surface text-muted-foreground hover:bg-surface-muted hover:text-foreground',
            )}
          >
            {option === 'all' ? t('capabilities.filterAll') : t(`capabilities.groups.${option}`)}
          </button>
        );
      })}
    </div>
  );
}

/** A probe's outcome: whether it succeeded (and why not), how long it took, the status after it. */
function ProbeDialog({
  probed,
  onClose,
}: {
  probed: { name: string; out: ProbeOut } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const result = probed?.out.result;
  const reason =
    result && isErrorKind(result.error_kind)
      ? t(`capabilities.connector.errorKinds.${result.error_kind}`)
      : t('capabilities.connector.errorKinds.unknown');
  return (
    <Dialog open={probed !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('capabilities.connector.probeDialog.title', { name: probed?.name ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('capabilities.connector.probeDialog.description')}</DialogDescription>
        </DialogHeader>
        {probed && result && (
          <div className="flex flex-col gap-3 text-sm">
            {result.ok ? (
              <Callout tone="success">{t('capabilities.connector.probeDialog.ok')}</Callout>
            ) : (
              <Callout tone="danger">
                <p>{t('capabilities.connector.probeDialog.failed', { reason })}</p>
                {result.error_reason && (
                  <p className="mt-1 break-words text-caption" data-probe-reason="">
                    {t('capabilities.connector.reasonLine', { reason: result.error_reason })}
                  </p>
                )}
              </Callout>
            )}
            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-0.5">
                <dt className="text-caption text-muted-foreground">
                  {t('capabilities.connector.probeDialog.latency')}
                </dt>
                <dd className="text-foreground">
                  {t('capabilities.connector.probeDialog.latencyValue', { ms: result.latency_ms })}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-caption text-muted-foreground">
                  {t('capabilities.connector.probeDialog.status')}
                </dt>
                <dd>
                  <CapabilityStatusBadge status={probed.out.status} />
                </dd>
              </div>
            </dl>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CapabilitiesPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const navigate = useNavigate();
  const canManage = can(session.data, 'capabilities.manage');
  const canProbe = can(session.data, 'workspace.read');
  const canCall = can(session.data, 'calls.work');
  const canUsePhones = can(session.data, 'devices.work');
  // A bridge key holds exactly `devices.bridge`, which its issuer must hold too.
  const canPair = can(session.data, 'api_keys.manage') && can(session.data, 'devices.bridge');
  const [params, setParams] = useSearchParams();
  const requestedGoal = params.get('goal');
  const goal: CapabilityGoal = CAPABILITY_GOALS.includes(requestedGoal as CapabilityGoal)
    ? (requestedGoal as CapabilityGoal)
    : 'all';
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const [section, setSection] = useState('connections');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'attention' | 'verified' | 'retired'>('all');
  const chooseGoal = (next: CapabilityGoal) => {
    setFilter('all');
    setPage(1);
    setParams((previous) => {
      const copy = new URLSearchParams(previous);
      if (next === 'all') copy.delete('goal');
      else copy.set('goal', next);
      return copy;
    });
  };
  const clearFilters = () => {
    setSearch('');
    setStatus('all');
    setFilter('all');
    chooseGoal('all');
  };

  const [probed, setProbed] = useState<{ name: string; out: ProbeOut } | null>(null);
  const [declaring, setDeclaring] = useState(false);
  const [action, setAction] = useState<{ kind: CapabilityAction; item: CapabilityOut } | null>(null);

  // The filter is the server's `group` parameter; the unfiltered list also feeds the groups panel.
  // The Devices tab follows its phones: their bridges register every heartbeat, so it reads them
  // (and each card its log) again as often, while it is shown.
  const devices = filter === 'device' || goal === 'devices';
  const listed = useQuery({
    queryKey: [...CAPABILITIES_KEY, filter],
    queryFn: () => listCapabilities(filter === 'all' ? {} : { group: filter }),
    refetchInterval: devices ? PHONE_REFRESH_MS : false,
  });
  const all = useQuery({ queryKey: [...CAPABILITIES_KEY, 'all'], queryFn: () => listCapabilities() });
  const groups = useQuery({ queryKey: GROUPS_KEY, queryFn: listGroups });
  const budgetItems = useQuery({ queryKey: BUDGET_ITEMS_KEY, queryFn: listBudgetItems });
  const health = useQuery({ queryKey: CONNECTOR_HEALTH_KEY, queryFn: connectorHealth });
  const healthOf = (id: string) => health.data?.find((h) => h.capability_id === id);

  // A probe asks the provider now; the list (and the health) refresh after it, whatever it found.
  const probe = useMutation({
    mutationFn: (item: CapabilityOut) => probeConnector(item.capability.id),
    onSuccess: (out, item) => setProbed({ name: item.capability.name, out }),
    onError: (err) => toast.error(errorMessage(t, err)),
    onSettled: () => invalidateCapabilities(queryClient),
  });
  // A Meta or X capability is reconnected by signing in at the provider again.
  const reconnect = useMutation({
    mutationFn: async (id: string) => {
      const out = await reconnectConnector(id);
      const url = providerUrl(out.authorize_url);
      if (!url) throw new Error('the provider address is not an https address');
      rememberStart(out, id);
      return url;
    },
    onSuccess: (url) => {
      toast.info(t('capabilities.connector.redirecting'));
      browser.assign(url);
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const onConnector = (kind: ConnectorAction, item: CapabilityOut) => {
    const c = item.capability;
    if (kind === 'probe') {
      probe.mutate(item);
    } else if (connectsByOAuth(c.kind_key)) {
      // A Meta or X account signs in at once through a flow bound to this capability: a
      // reconnection renews it; a declared one becomes the first account chosen (no orphan).
      reconnect.mutate(c.id);
    } else if (providerOf(c.kind_key) === 'netgsm') {
      // NetGSM takes its credentials (again) on the connect page, for this capability.
      navigate(`/connect?capability=${encodeURIComponent(c.id)}`);
    }
  };

  const retire = useMutation({
    mutationFn: (id: string) => retireCapability(id),
    onSuccess: async () => {
      setAction(null);
      toast.success(t('capabilities.retireDialog.retired'));
      await invalidateCapabilities(queryClient);
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const unlink = useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) => unlinkBudget(id, itemId),
    onSuccess: async () => {
      toast.success(t('capabilities.linkDialog.unlinked'));
      await invalidateCapabilities(queryClient);
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const target = (kind: CapabilityAction) => (action?.kind === kind ? action.item : null);
  const close = () => setAction(null);
  const source = listed.data ?? [];
  const needle = search.trim().toLocaleLowerCase(i18n.language);
  const items = source
    .filter((item) => matchesGoal(item, goal))
    .filter((item) => {
      if (status === 'attention' && !needsCapabilityAttention(item, healthOf(item.capability.id)))
        return false;
      if (status === 'verified' && item.effective_status !== 'verified') return false;
      if (status === 'retired' && item.effective_status !== 'retired') return false;
      return (
        !needle ||
        [
          item.capability.name,
          item.capability.external_id ?? '',
          kindLabel(t, item.capability.kind_key),
        ].some((value) => value.toLocaleLowerCase(i18n.language).includes(needle))
      );
    });
  const pageCount = Math.max(1, Math.ceil(items.length / 8));
  const activePage = Math.min(page, pageCount);
  const visibleItems = items.slice((activePage - 1) * 8, activePage * 8);
  const firstConnection = all.isSuccess && all.data.length === 0;
  const filtered = goal !== 'all' || filter !== 'all' || status !== 'all' || !!search;

  return (
    <>
      <PageHeader
        title={t('capabilities.title')}
        description={t('capabilities.description')}
        actions={
          canManage ? (
            <>
              <Button asChild variant="outline">
                <Link to="/connect">
                  <Plug className="h-4 w-4" aria-hidden="true" />
                  {t('connect.open')}
                </Link>
              </Button>
              <Button onClick={() => setDeclaring(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('capabilities.declare')}
              </Button>
            </>
          ) : null
        }
      />
      <Tabs value={section} onValueChange={setSection}>
        <TabsList aria-label={t('capabilities.title')} className="flex w-full flex-wrap">
          <TabsTrigger value="connections" className="min-h-11 px-3 sm:px-4">
            {t('capabilities.workbench.inventory')}
          </TabsTrigger>
          <TabsTrigger value="groups" className="min-h-11 px-3 sm:px-4">
            {t('capabilities.workbench.groupsTab')}
          </TabsTrigger>
          {canManage && (
            <TabsTrigger value="technical" className="min-h-11 px-3 sm:px-4">
              {t('capabilities.workbench.technicalTab')}
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="connections" className="space-y-5">
          <PurposePanel
            goal={goal}
            onChange={chooseGoal}
            canManage={canManage}
            canPair={canPair}
            onDeclare={() => setDeclaring(true)}
            onDevices={() => {
              setFilter('device');
              setPage(1);
              document.getElementById('capability-inventory')?.scrollIntoView?.({ block: 'start' });
            }}
          />
          <section id="capability-inventory" className="scroll-mt-6 space-y-4">
            {!firstConnection && (
              <>
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-medium">{t('capabilities.workbench.inventory')}</h2>
                    {listed.isSuccess && (
                      <p className="mt-1 text-caption text-muted-foreground" role="status">
                        {t('capabilities.workbench.count', { count: items.length })}
                      </p>
                    )}
                  </div>
                  {filtered && (
                    <Button variant="ghost" onClick={clearFilters}>
                      {t('capabilities.workbench.clear')}
                    </Button>
                  )}
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Input
                    aria-label={t('capabilities.workbench.search')}
                    placeholder={t('capabilities.workbench.searchPlaceholder')}
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    className="sm:max-w-sm"
                  />
                  <select
                    aria-label={t('capabilities.workbench.statusLabel')}
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value as typeof status);
                      setPage(1);
                    }}
                    className="h-10 min-w-0 rounded-md border border-input bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {(['all', 'attention', 'verified', 'retired'] as const).map((value) => (
                      <option key={value} value={value}>
                        {t(`capabilities.workbench.${value === 'all' ? 'allStatus' : value}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <Disclosure title={t('capabilities.workbench.advanced')}>
                  <FilterChips
                    value={filter}
                    onChange={(next) => {
                      setFilter(next);
                      setPage(1);
                    }}
                  />
                </Disclosure>
              </>
            )}
            {filter === 'device' && canPair && <PairBridgePanel />}
            {/* A refresh that fails keeps the cards (and an open command row) on screen. */}
            <QueryState query={listed} keepOnError>
              {items.length === 0 ? (
                filtered && !firstConnection ? (
                  <EmptyState
                    title={t('capabilities.workbench.noMatch')}
                    description={t('capabilities.workbench.noMatchBody')}
                  />
                ) : (
                  <section
                    className="flex items-start gap-4 border-y border-border bg-surface p-4 sm:items-center sm:gap-6 sm:p-6"
                    aria-label={t('capabilities.empty')}
                  >
                    <img
                      src="/brand/guide-setup.webp"
                      alt=""
                      aria-hidden="true"
                      width={112}
                      height={112}
                      className="h-20 w-20 shrink-0 object-contain sm:h-28 sm:w-28"
                    />
                    <div className="min-w-0 space-y-3">
                      <div>
                        <h3 className="text-base font-medium">{t('capabilities.empty')}</h3>
                        <p className="mt-1 max-w-lg text-sm leading-6 text-muted-foreground">
                          {t(
                            canManage
                              ? 'capabilities.workbench.startHelp'
                              : 'capabilities.workbench.managerNeeded',
                          )}
                        </p>
                      </div>
                      {canManage && (
                        <Button asChild>
                          <Link to="/connect">{t('capabilities.workbench.startConnection')}</Link>
                        </Button>
                      )}
                    </div>
                  </section>
                )
              ) : (
                <div className="divide-y divide-border border-y border-border">
                  {visibleItems.map((item) => (
                    <CapabilityCard
                      key={item.capability.id}
                      item={item}
                      budgetItems={budgetItems.data ?? []}
                      groups={groups.data ?? []}
                      canManage={canManage}
                      onAction={(kind, it) => setAction({ kind, item: it })}
                      onUnlink={(it, itemId) => unlink.mutate({ id: it.capability.id, itemId })}
                      unlinking={unlink.isPending}
                      health={healthOf(item.capability.id)}
                      canProbe={canProbe}
                      onConnector={onConnector}
                      connectorBusy={probe.isPending || reconnect.isPending}
                      canCall={canCall}
                      canUsePhones={canUsePhones}
                      livePhones={devices}
                      readAt={listed.dataUpdatedAt}
                    />
                  ))}
                </div>
              )}
            </QueryState>
            {pageCount > 1 && (
              <nav
                aria-label={t('capabilities.workbench.pagination')}
                className="flex items-center justify-between gap-3 border-t border-border pt-3"
              >
                <Button variant="outline" disabled={activePage === 1} onClick={() => setPage(activePage - 1)}>
                  {t('capabilities.workbench.previous')}
                </Button>
                <span className="text-caption text-muted-foreground">
                  {t('capabilities.workbench.page', { current: activePage, total: pageCount })}
                </span>
                <Button
                  variant="outline"
                  disabled={activePage === pageCount}
                  onClick={() => setPage(activePage + 1)}
                >
                  {t('capabilities.workbench.next')}
                </Button>
              </nav>
            )}
          </section>
        </TabsContent>
        <TabsContent value="groups">
          <QueryState query={groups}>
            <GroupsPanel groups={groups.data ?? []} capabilities={all.data ?? []} canManage={canManage} />
          </QueryState>
        </TabsContent>
        {canManage && (
          <TabsContent value="technical">
            <WebhookPanel />
          </TabsContent>
        )}
      </Tabs>
      <ProbeDialog probed={probed} onClose={() => setProbed(null)} />

      {canManage && (
        <>
          <DeclareDialog open={declaring} onOpenChange={setDeclaring} />
          <EditDialog target={target('edit')} onClose={close} />
          <VerifyDialog target={target('verify')} onClose={close} />
          <PolicyDialog target={target('policy')} onClose={close} />
          <UnreachableDialog target={target('unreachable')} onClose={close} />
          <LinkBudgetDialog target={target('link')} budgetItems={budgetItems.data ?? []} onClose={close} />
          <ConfirmDialog
            open={action?.kind === 'retire'}
            onOpenChange={(open) => !open && close()}
            title={t('capabilities.retireDialog.title')}
            description={
              action?.kind === 'retire'
                ? t('capabilities.retireDialog.body', { name: action.item.capability.name })
                : undefined
            }
            confirmLabel={t('capabilities.actions.retire')}
            cancelLabel={t('common.cancel')}
            tone="danger"
            loading={retire.isPending}
            onConfirm={() => action?.kind === 'retire' && retire.mutate(action.item.capability.id)}
          />
        </>
      )}
    </>
  );
}
