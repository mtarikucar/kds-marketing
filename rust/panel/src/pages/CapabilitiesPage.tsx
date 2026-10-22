import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listBudgetItems } from '@/api/budget';
import { listCapabilities, listGroups, retireCapability, unlinkBudget } from '@/api/capabilities';
import { KIND_GROUPS, type CapabilityOut, type KindGroup } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { CapabilityCard, type CapabilityAction } from '@/components/CapabilityCard';
import { QueryState } from '@/components/QueryState';
import { Button, ConfirmDialog, EmptyState, PageHeader, cn, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { can } from '@/lib/roles';
import { DeclareDialog, LinkBudgetDialog, PolicyDialog, UnreachableDialog, VerifyDialog } from './capabilities/dialogs';
import { GroupsPanel } from './capabilities/GroupsPanel';
import { BUDGET_ITEMS_KEY, CAPABILITIES_KEY, GROUPS_KEY, invalidateCapabilities } from './capabilities/queries';

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

export function CapabilitiesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const canManage = can(session.data, 'capabilities.manage');
  const [filter, setFilter] = useState<Filter>('all');
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
            <Button onClick={() => setDeclaring(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('capabilities.declare')}
            </Button>
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
              />
            ))}
          </div>
        )}
      </QueryState>
      <QueryState query={groups}>
        <GroupsPanel groups={groups.data ?? []} capabilities={all.data ?? []} canManage={canManage} />
      </QueryState>

      {canManage && (
        <>
          <DeclareDialog open={declaring} onOpenChange={setDeclaring} />
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
