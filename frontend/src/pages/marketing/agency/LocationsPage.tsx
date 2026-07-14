import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Building2, Users, UserCheck, PauseCircle, PlayCircle, MoreHorizontal, LogIn } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  StatCard,
  DataTable,
  EmptyState,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  type BadgeProps,
} from '@/components/ui';
import { AgencyGuard } from './AgencyGuard';
import { useLocations, useAgencyDashboard, useLocationMutations } from './hooks';
import type { Location, DashboardLocation } from './types';
import { apiError, formatDate } from './util';
import { CreateLocationDialog } from './CreateLocationDialog';
import type { CreateLocationFormValues } from './schemas';

const STATUS_TONE: Record<string, BadgeProps['tone']> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'danger',
};

interface Row extends Location {
  leadCount?: number;
  userCount?: number;
}

function LocationsPageInner() {
  const { t } = useTranslation('marketing');
  const { data: locations, isLoading } = useLocations();
  const { data: dashboard } = useAgencyDashboard();
  const { create, setStatus, access } = useLocationMutations();
  const navigate = useNavigate();

  const [createOpen, setCreateOpen] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<Row | null>(null);

  // Merge per-location counts (from the dashboard summary) onto the list rows.
  const rows: Row[] = useMemo(() => {
    const counts = new Map<string, DashboardLocation>();
    (dashboard?.locations ?? []).forEach((l) => counts.set(l.id, l));
    return (locations ?? []).map((l) => ({
      ...l,
      leadCount: counts.get(l.id)?.leadCount,
      userCount: counts.get(l.id)?.userCount,
    }));
  }, [locations, dashboard]);

  const handleCreate = (values: CreateLocationFormValues) => {
    create.mutate(values, {
      onSuccess: () => {
        setCreateOpen(false);
        toast.success(t('agency.locations.created', { defaultValue: 'Sub-account created' }));
      },
      onError: (e) =>
        toast.error(apiError(e, t('agency.locations.createError', { defaultValue: 'Failed to create sub-account' }))),
    });
  };

  const columns: ColumnDef<Row, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('agency.locations.name', { defaultValue: 'Location' }),
      cell: ({ row }) => (
        <div>
          <p className="text-sm font-medium text-foreground">{row.original.name}</p>
          <code className="text-xs text-muted-foreground">{row.original.slug}</code>
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: t('agency.locations.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const s = String(getValue());
        return (
          <Badge tone={STATUS_TONE[s] ?? 'neutral'} size="sm">
            {t(`agency.statuses.${s}`, { defaultValue: s })}
          </Badge>
        );
      },
    },
    {
      id: 'leads',
      header: t('agency.locations.leads', { defaultValue: 'Leads' }),
      cell: ({ row }) => <span className="text-sm tabular-nums text-foreground">{row.original.leadCount ?? '—'}</span>,
    },
    {
      id: 'users',
      header: t('agency.locations.users', { defaultValue: 'Users' }),
      cell: ({ row }) => <span className="text-sm tabular-nums text-foreground">{row.original.userCount ?? '—'}</span>,
    },
    {
      id: 'created',
      header: t('agency.locations.created', { defaultValue: 'Created' }),
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatDate(row.original.createdAt)}</span>,
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const loc = row.original;
        const isActive = loc.status === 'ACTIVE';
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isActive && (
                <DropdownMenuItem
                  disabled={access.isPending}
                  onClick={() =>
                    access.mutate(
                      { id: loc.id, name: loc.name },
                      {
                        onSuccess: () => navigate('/'),
                        onError: (e) =>
                          toast.error(
                            apiError(e, t('agency.locations.enterError', { defaultValue: 'Could not open the sub-account' })),
                          ),
                      },
                    )
                  }
                >
                  <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('agency.locations.enter', { defaultValue: 'Open sub-account' })}
                </DropdownMenuItem>
              )}
              {isActive ? (
                <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setSuspendTarget(loc)}>
                  <PauseCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('agency.locations.suspend', { defaultValue: 'Suspend' })}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setSuspendTarget(loc)}>
                  <PlayCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('agency.locations.reactivate', { defaultValue: 'Reactivate' })}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const suspendingActive = suspendTarget?.status === 'ACTIVE';
  const nextStatus: 'SUSPENDED' | 'ACTIVE' = suspendingActive ? 'SUSPENDED' : 'ACTIVE';

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('agency.locations.title', { defaultValue: 'Sub-accounts' })}
        description={t('agency.locations.subtitle', {
          defaultValue: 'Create and manage the child locations your agency runs.',
        })}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('agency.locations.createTitle', { defaultValue: 'New sub-account' })}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label={t('agency.summary.locations', { defaultValue: 'Locations' })}
          value={String(dashboard?.locationCount ?? rows.length)}
          icon={<Building2 className="h-5 w-5" />}
          tone="primary"
        />
        <StatCard
          label={t('agency.summary.active', { defaultValue: 'Active locations' })}
          value={String(dashboard?.activeLocationCount ?? '—')}
          icon={<UserCheck className="h-5 w-5" />}
          tone="success"
        />
        <StatCard
          label={t('agency.summary.totalLeads', { defaultValue: 'Total leads' })}
          value={String(dashboard?.totalLeads ?? '—')}
          icon={<Users className="h-5 w-5" />}
        />
      </div>

      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        loadingRowCount={5}
        emptyState={
          <EmptyState
            icon={<Building2 className="h-10 w-10" />}
            title={t('agency.locations.empty', { defaultValue: 'No sub-accounts yet' })}
            description={t('agency.locations.emptyHint', {
              defaultValue: 'Create your first child location to start managing it from here.',
            })}
            action={
              <Button onClick={() => setCreateOpen(true)} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('agency.locations.createTitle', { defaultValue: 'New sub-account' })}
              </Button>
            }
          />
        }
      />

      <CreateLocationDialog open={createOpen} onOpenChange={setCreateOpen} onSubmit={handleCreate} isPending={create.isPending} />

      <ConfirmDialog
        open={!!suspendTarget}
        onOpenChange={(o) => {
          if (!o) setSuspendTarget(null);
        }}
        title={
          suspendingActive
            ? t('agency.locations.suspendTitle', { defaultValue: 'Suspend sub-account' })
            : t('agency.locations.reactivateTitle', { defaultValue: 'Reactivate sub-account' })
        }
        description={
          suspendingActive
            ? t('agency.locations.suspendDesc', {
                defaultValue: 'Suspending blocks the location’s users from logging in. You can reactivate it later.',
              })
            : t('agency.locations.reactivateDesc', {
                defaultValue: 'Reactivating restores login access for the location’s users.',
              })
        }
        confirmLabel={
          suspendingActive
            ? t('agency.locations.suspend', { defaultValue: 'Suspend' })
            : t('agency.locations.reactivate', { defaultValue: 'Reactivate' })
        }
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone={suspendingActive ? 'danger' : 'default'}
        loading={setStatus.isPending}
        onConfirm={() =>
          suspendTarget &&
          setStatus.mutate(
            { id: suspendTarget.id, status: nextStatus },
            {
              onSuccess: () => {
                setSuspendTarget(null);
                toast.success(
                  suspendingActive
                    ? t('agency.locations.suspended', { defaultValue: 'Sub-account suspended' })
                    : t('agency.locations.reactivated', { defaultValue: 'Sub-account reactivated' }),
                );
              },
              onError: (e) => toast.error(apiError(e, t('agency.locations.statusError', { defaultValue: 'Failed to update status' }))),
            },
          )
        }
      />
    </div>
  );
}

export default function LocationsPage() {
  return (
    <AgencyGuard>
      <LocationsPageInner />
    </AgencyGuard>
  );
}
