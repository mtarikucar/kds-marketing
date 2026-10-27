import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
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
  EmptyState,
  PageHeader,
  cn,
  toast,
} from '@/components/ui';
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
import { WebhookPanel } from './capabilities/WebhookPanel';
import {
  BUDGET_ITEMS_KEY,
  CAPABILITIES_KEY,
  CONNECTOR_HEALTH_KEY,
  GROUPS_KEY,
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
              'rounded-full border px-3 py-1 text-caption font-medium transition-colors',
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
function ProbeDialog({ probed, onClose }: { probed: { name: string; out: ProbeOut } | null; onClose: () => void }) {
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
          <DialogTitle>{t('capabilities.connector.probeDialog.title', { name: probed?.name ?? '' })}</DialogTitle>
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
                <dt className="text-caption text-muted-foreground">{t('capabilities.connector.probeDialog.latency')}</dt>
                <dd className="text-foreground">
                  {t('capabilities.connector.probeDialog.latencyValue', { ms: result.latency_ms })}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-caption text-muted-foreground">{t('capabilities.connector.probeDialog.status')}</dt>
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
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const navigate = useNavigate();
  const canManage = can(session.data, 'capabilities.manage');
  const canProbe = can(session.data, 'workspace.read');
  const [filter, setFilter] = useState<Filter>('all');
  const [probed, setProbed] = useState<{ name: string; out: ProbeOut } | null>(null);
  const [declaring, setDeclaring] = useState(false);
  const [action, setAction] = useState<{ kind: CapabilityAction; item: CapabilityOut } | null>(null);

  // The filter is the server's `group` parameter; the unfiltered list also feeds the groups panel.
  const listed = useQuery({
    queryKey: [...CAPABILITIES_KEY, filter],
    queryFn: () => listCapabilities(filter === 'all' ? {} : { group: filter }),
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
  const items = listed.data ?? [];

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
      <FilterChips value={filter} onChange={setFilter} />
      <QueryState query={listed}>
        {items.length === 0 ? (
          <EmptyState title={t('capabilities.empty')} description={t('capabilities.emptyBody')} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {items.map((item) => (
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
              />
            ))}
          </div>
        )}
      </QueryState>
      <ProbeDialog probed={probed} onClose={() => setProbed(null)} />
      <QueryState query={groups}>
        <GroupsPanel groups={groups.data ?? []} capabilities={all.data ?? []} canManage={canManage} />
      </QueryState>
      {/* The NetGSM addresses carry the workspace's hook tokens: only who may manage capabilities. */}
      {canManage && <WebhookPanel />}

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
