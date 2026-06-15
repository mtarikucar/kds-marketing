import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Building2 } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

const STATUS_TONE: Record<string, NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'neutral',
};

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  productName: string;
  defaultCurrency: string;
  createdAt: string;
  counts: { users: number; leads: number };
}

/** A pending status transition awaiting operator confirmation. */
interface PendingStatus {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
}

export default function PlatformWorkspacesPage() {
  const { isAuthenticated } = usePlatformAuthStore();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<PendingStatus | null>(null);

  const { data: workspaces, isLoading } = useQuery<WorkspaceRow[]>({
    queryKey: ['platform', 'workspaces', { search, status }],
    queryFn: () =>
      platformApi
        .get('/workspaces', { params: { search: search || undefined, status: status || undefined } })
        .then((r) => r.data),
    // Don't fetch until authenticated — preserves the original
    // no-request-before-redirect behavior now that the guard sits in the layout.
    enabled: isAuthenticated,
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      platformApi.patch(`/workspaces/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'workspaces'] });
      toast.success('Workspace status updated');
      setPending(null);
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? 'Update failed'),
  });

  const columns = useMemo<ColumnDef<WorkspaceRow, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Workspace',
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-medium text-foreground">{row.original.name}</div>
            <div className="text-xs text-muted-foreground">{row.original.slug}</div>
          </div>
        ),
      },
      {
        accessorKey: 'productName',
        header: 'Product',
        cell: ({ getValue }) => (
          <span className="text-muted-foreground">{getValue<string>()}</span>
        ),
      },
      {
        id: 'users',
        header: 'Users',
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">{row.original.counts.users}</span>
        ),
      },
      {
        id: 'leads',
        header: 'Leads',
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">{row.original.counts.leads}</span>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return (
            <Badge tone={STATUS_TONE[val] ?? 'neutral'} size="sm">
              {val}
            </Badge>
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const w = row.original;
          return (
            <div
              className="flex justify-end"
              onClick={(e) => e.stopPropagation()}
              // Row is keyboard-activatable; stop Enter/Space on the action area
              // from also navigating into the detail page.
              onKeyDown={(e) => e.stopPropagation()}
            >
              {w.status === 'ACTIVE' ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={statusMutation.isPending}
                  onClick={() => setPending({ id: w.id, name: w.name, status: 'SUSPENDED' })}
                >
                  Suspend
                </Button>
              ) : w.status === 'SUSPENDED' ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={statusMutation.isPending}
                  onClick={() => setPending({ id: w.id, name: w.name, status: 'ACTIVE' })}
                >
                  Activate
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [statusMutation.isPending],
  );

  return (
    <div className="space-y-5">
      <PageHeader title="Workspaces" description="All tenant workspaces on the platform." />

      <FilterBar
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search name / slug / product…',
        }}
      >
        <Select value={status || '__ALL__'} onValueChange={(v) => setStatus(v === '__ALL__' ? '' : v)}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__ALL__">All statuses</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="SUSPENDED">Suspended</SelectItem>
            <SelectItem value="CLOSED">Closed</SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>

      <DataTable
        columns={columns}
        data={workspaces ?? []}
        isLoading={isLoading}
        onRowClick={(w) => navigate(`/platform/workspaces/${w.id}`)}
        emptyState={
          <EmptyState
            icon={<Building2 className="h-10 w-10" />}
            title="No workspaces"
            description="No workspaces match the current filters."
          />
        }
      />

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.status === 'SUSPENDED' ? 'Suspend workspace' : 'Activate workspace'}
        description={
          pending?.status === 'SUSPENDED'
            ? `Suspend workspace "${pending?.name}"? Users will lose access until it is reactivated.`
            : `Activate workspace "${pending?.name}"? Users will regain access immediately.`
        }
        confirmLabel={pending?.status === 'SUSPENDED' ? 'Suspend' : 'Activate'}
        tone={pending?.status === 'SUSPENDED' ? 'danger' : 'default'}
        loading={statusMutation.isPending}
        onConfirm={() => pending && statusMutation.mutate({ id: pending.id, status: pending.status })}
      />
    </div>
  );
}
