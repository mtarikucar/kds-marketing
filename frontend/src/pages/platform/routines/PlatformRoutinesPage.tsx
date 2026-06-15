import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Play, Settings2, Repeat } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { usePlatformAuthStore } from '../../../store/platformAuthStore';
import platformApi from '../../../features/platform/api/platformApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable } from '@/components/ui/DataTable';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { RoutineConfigDialog } from './RoutineConfigDialog';
import {
  STATUS_TONE,
  extractMessage,
  relativeTime,
  routineLabel,
  type RoutineConfig,
  type TriggerResult,
} from './routines';

export default function PlatformRoutinesPage() {
  const { isAuthenticated } = usePlatformAuthStore();
  const queryClient = useQueryClient();
  const [configuring, setConfiguring] = useState<RoutineConfig | null>(null);

  const { data: routines, isLoading, isError } = useQuery<RoutineConfig[]>({
    queryKey: ['platform', 'routines'],
    queryFn: () => platformApi.get('/routines').then((r) => r.data),
    enabled: isAuthenticated,
  });

  const triggerMutation = useMutation({
    mutationFn: (key: string) =>
      platformApi.post<TriggerResult>(`/routines/${key}/trigger`).then((r) => r.data),
    onSuccess: (result, key) => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'routines'] });
      if (result.ok) {
        toast.success(`${routineLabel(key)} triggered`);
      } else if (result.skipped) {
        toast.warning(`Skipped — ${result.skipped}`);
      } else {
        toast.error(`Trigger failed: ${result.error ?? 'unknown error'}`);
      }
    },
    onError: (e: unknown) => toast.error(extractMessage(e)),
  });

  const triggeringKey = triggerMutation.isPending ? triggerMutation.variables : null;

  const columns = useMemo<ColumnDef<RoutineConfig, unknown>[]>(
    () => [
      {
        accessorKey: 'key',
        header: 'Routine',
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-medium text-foreground">{routineLabel(row.original.key)}</div>
            <div className="font-mono text-xs text-muted-foreground">{row.original.key}</div>
          </div>
        ),
      },
      {
        id: 'state',
        header: 'State',
        cell: ({ row }) => (
          <Badge tone={row.original.enabled ? 'success' : 'neutral'} size="sm">
            {row.original.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        ),
      },
      {
        id: 'schedule',
        header: 'Schedule',
        cell: ({ row }) =>
          row.original.cron ? (
            <span className="font-mono text-xs text-muted-foreground">{row.original.cron}</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        id: 'lastRun',
        header: 'Last run',
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex items-center gap-2">
              {r.lastTriggerStatus && (
                <Badge tone={STATUS_TONE[r.lastTriggerStatus] ?? 'neutral'} size="sm">
                  {r.lastTriggerStatus}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{relativeTime(r.lastTriggeredAt)}</span>
            </div>
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={triggeringKey === r.key}
                loading={triggeringKey === r.key}
                onClick={() => triggerMutation.mutate(r.key)}
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                Trigger
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfiguring(r)}>
                <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
                Configure
              </Button>
            </div>
          );
        },
      },
    ],
    [triggerMutation, triggeringKey],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Routines"
        description="Scheduled and event-driven automations across the platform."
      />

      {isError && (
        <Callout tone="danger" title="Failed to load routines">
          Check your session and try again.
        </Callout>
      )}

      <DataTable
        columns={columns}
        data={routines ?? []}
        isLoading={isLoading}
        emptyState={
          <EmptyState
            icon={<Repeat className="h-10 w-10" />}
            title="No routines"
            description="No automations are configured yet."
          />
        }
      />

      <RoutineConfigDialog
        open={!!configuring}
        onOpenChange={(open) => {
          if (!open) setConfiguring(null);
        }}
        routine={configuring}
      />
    </div>
  );
}
