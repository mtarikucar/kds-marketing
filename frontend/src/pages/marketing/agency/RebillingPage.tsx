import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Building2, Calculator, Receipt, Settings2, MoreHorizontal } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  PageHeader,
  IconButton,
  Badge,
  DataTable,
  EmptyState,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  type BadgeProps,
} from '@/components/ui';
import { AgencyGuard } from './AgencyGuard';
import {
  useLocations,
  useRebillingPlans,
  useRebillingCharges,
  useRebillingMutations,
} from './hooks';
import type { Location, RebillCharge, RebillingPlan } from './types';
import { apiError, formatDate, formatMoney } from './util';
import { PlanEditorDialog } from './PlanEditorDialog';
import { ComputeChargeDialog } from './ComputeChargeDialog';
import type { RebillingPlanFormValues } from './schemas';

const CHARGE_TONE: Record<string, BadgeProps['tone']> = {
  DRAFT: 'neutral',
  INVOICED: 'info',
  PAID: 'success',
  FAILED: 'danger',
};

interface LocRow extends Location {
  plan?: RebillingPlan;
}

function RebillingPageInner() {
  const { t } = useTranslation('marketing');
  const { data: locations, isLoading: locLoading } = useLocations();
  const { data: plans } = useRebillingPlans();
  const { data: charges, isLoading: chargesLoading } = useRebillingCharges();
  const { upsertPlan } = useRebillingMutations();

  const [planTarget, setPlanTarget] = useState<LocRow | null>(null);
  const [chargeTarget, setChargeTarget] = useState<LocRow | null>(null);

  const planByLoc = useMemo(() => {
    const m = new Map<string, RebillingPlan>();
    (plans ?? []).forEach((p) => m.set(p.locationWorkspaceId, p));
    return m;
  }, [plans]);

  const locName = useMemo(() => {
    const m = new Map<string, string>();
    (locations ?? []).forEach((l) => m.set(l.id, l.name));
    return m;
  }, [locations]);

  const rows: LocRow[] = useMemo(
    () => (locations ?? []).map((l) => ({ ...l, plan: planByLoc.get(l.id) })),
    [locations, planByLoc],
  );

  const handleSavePlan = (values: RebillingPlanFormValues) => {
    if (!planTarget) return;
    upsertPlan.mutate(
      { locationId: planTarget.id, data: values },
      {
        onSuccess: () => {
          setPlanTarget(null);
          toast.success(t('agency.rebilling.planSaved', { defaultValue: 'Plan saved' }));
        },
        onError: (e) => toast.error(apiError(e, t('agency.rebilling.planError', { defaultValue: 'Failed to save plan' }))),
      },
    );
  };

  const planColumns: ColumnDef<LocRow, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('agency.locations.name', { defaultValue: 'Location' }),
      cell: ({ row }) => <span className="text-sm font-medium text-foreground">{row.original.name}</span>,
    },
    {
      id: 'plan',
      header: t('agency.rebilling.plan', { defaultValue: 'Plan' }),
      cell: ({ row }) => {
        const p = row.original.plan;
        if (!p) {
          return <span className="text-sm text-muted-foreground">{t('agency.rebilling.noPlan', { defaultValue: 'No plan' })}</span>;
        }
        return (
          <Badge tone={p.enabled ? 'success' : 'neutral'} size="sm">
            {p.enabled ? t('agency.rebilling.enabledShort', { defaultValue: 'Enabled' }) : t('agency.rebilling.disabledShort', { defaultValue: 'Disabled' })}
          </Badge>
        );
      },
    },
    {
      id: 'base',
      header: t('agency.rebilling.basePrice', { defaultValue: 'Base' }),
      cell: ({ row }) => <span className="text-sm tabular-nums text-foreground">{row.original.plan ? formatMoney(row.original.plan.basePrice, row.original.defaultCurrency) : '—'}</span>,
    },
    {
      id: 'markup',
      header: t('agency.rebilling.markupPercent', { defaultValue: 'Markup %' }),
      cell: ({ row }) => <span className="text-sm tabular-nums text-foreground">{row.original.plan ? `${row.original.plan.markupPercent}%` : '—'}</span>,
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setPlanTarget(row.original)}>
              <Settings2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {row.original.plan ? t('agency.rebilling.editPlan', { defaultValue: 'Edit plan' }) : t('agency.rebilling.newPlan', { defaultValue: 'New plan' })}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!row.original.plan} onClick={() => setChargeTarget(row.original)}>
              <Calculator className="mr-2 h-4 w-4" aria-hidden="true" />
              {t('agency.rebilling.computeTitle', { defaultValue: 'Compute charge' })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const chargeColumns: ColumnDef<RebillCharge, unknown>[] = [
    {
      id: 'location',
      header: t('agency.locations.name', { defaultValue: 'Location' }),
      cell: ({ row }) => <span className="text-sm text-foreground">{locName.get(row.original.locationWorkspaceId) ?? row.original.locationWorkspaceId}</span>,
    },
    {
      id: 'period',
      header: t('agency.rebilling.period', { defaultValue: 'Period' }),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatDate(row.original.periodStart)} – {formatDate(row.original.periodEnd)}
        </span>
      ),
    },
    {
      id: 'total',
      header: t('agency.rebilling.total', { defaultValue: 'Total' }),
      cell: ({ row }) => <span className="text-sm font-medium tabular-nums text-foreground">{formatMoney(row.original.totalAmount)}</span>,
    },
    {
      accessorKey: 'status',
      header: t('agency.rebilling.statusCol', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const s = String(getValue());
        return (
          <Badge tone={CHARGE_TONE[s] ?? 'neutral'} size="sm">
            {t(`agency.rebilling.statuses.${s}`, { defaultValue: s })}
          </Badge>
        );
      },
    },
    {
      id: 'created',
      header: t('agency.snapshots.createdAt', { defaultValue: 'Created' }),
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatDate(row.original.createdAt)}</span>,
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('agency.rebilling.title', { defaultValue: 'Rebilling' })}
        description={t('agency.rebilling.subtitle', {
          defaultValue: 'Define a per-location SaaS plan and settle monthly charges against real usage.',
        })}
      />

      <Tabs defaultValue="plans">
        <TabsList>
          <TabsTrigger value="plans">{t('agency.rebilling.plansTab', { defaultValue: 'Plans' })}</TabsTrigger>
          <TabsTrigger value="charges">{t('agency.rebilling.chargesTab', { defaultValue: 'Charges' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="plans" className="pt-4">
          <DataTable
            columns={planColumns}
            data={rows}
            isLoading={locLoading}
            loadingRowCount={5}
            emptyState={
              <EmptyState
                icon={<Building2 className="h-10 w-10" />}
                title={t('agency.rebilling.noLocations', { defaultValue: 'No sub-accounts yet' })}
                description={t('agency.rebilling.noLocationsHint', {
                  defaultValue: 'Create a sub-account first, then set up its rebilling plan here.',
                })}
              />
            }
          />
        </TabsContent>

        <TabsContent value="charges" className="pt-4">
          <DataTable
            columns={chargeColumns}
            data={charges ?? []}
            isLoading={chargesLoading}
            loadingRowCount={5}
            emptyState={
              <EmptyState
                icon={<Receipt className="h-10 w-10" />}
                title={t('agency.rebilling.noCharges', { defaultValue: 'No charges yet' })}
                description={t('agency.rebilling.noChargesHint', {
                  defaultValue: 'Compute a charge from the Plans tab to record a settlement line.',
                })}
              />
            }
          />
        </TabsContent>
      </Tabs>

      <PlanEditorDialog
        open={!!planTarget}
        onOpenChange={(o) => {
          if (!o) setPlanTarget(null);
        }}
        location={planTarget}
        plan={planTarget?.plan ?? null}
        onSubmit={handleSavePlan}
        isPending={upsertPlan.isPending}
      />

      <ComputeChargeDialog
        open={!!chargeTarget}
        onOpenChange={(o) => {
          if (!o) setChargeTarget(null);
        }}
        location={chargeTarget}
      />
    </div>
  );
}

export default function RebillingPage() {
  return (
    <AgencyGuard>
      <RebillingPageInner />
    </AgencyGuard>
  );
}
