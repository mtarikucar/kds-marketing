import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Camera, CopyPlus } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  PageHeader,
  Button,
  DataTable,
  EmptyState,
} from '@/components/ui';
import { AgencyGuard } from './AgencyGuard';
import { useLocations, useSnapshots, useSnapshotMutations } from './hooks';
import type { SnapshotListItem } from './types';
import { apiError, formatDate } from './util';
import { CaptureSnapshotDialog } from './CaptureSnapshotDialog';
import { ApplySnapshotDialog } from './ApplySnapshotDialog';
import type { CaptureSnapshotFormValues } from './schemas';

function SnapshotsPageInner() {
  const { t } = useTranslation('marketing');
  const { data: snapshots, isLoading } = useSnapshots();
  const { data: locations } = useLocations();
  const { capture } = useSnapshotMutations();

  const [captureOpen, setCaptureOpen] = useState(false);
  const [applyTarget, setApplyTarget] = useState<SnapshotListItem | null>(null);

  const locs = locations ?? [];

  const handleCapture = (values: CaptureSnapshotFormValues) => {
    capture.mutate(values, {
      onSuccess: () => {
        setCaptureOpen(false);
        toast.success(t('agency.snapshots.captured', { defaultValue: 'Snapshot captured' }));
      },
      onError: (e) => toast.error(apiError(e, t('agency.snapshots.captureError', { defaultValue: 'Failed to capture snapshot' }))),
    });
  };

  const columns: ColumnDef<SnapshotListItem, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('agency.snapshots.name', { defaultValue: 'Snapshot' }),
      cell: ({ row }) => (
        <div>
          <p className="text-sm font-medium text-foreground">{row.original.name}</p>
          {row.original.description && (
            <p className="text-xs text-muted-foreground">{row.original.description}</p>
          )}
        </div>
      ),
    },
    {
      id: 'created',
      header: t('agency.snapshots.createdAt', { defaultValue: 'Captured' }),
      cell: ({ row }) => <span className="text-sm text-muted-foreground">{formatDate(row.original.createdAt)}</span>,
    },
    {
      id: 'actions',
      header: '',
      size: 120,
      cell: ({ row }) => (
        <Button size="sm" variant="outline" onClick={() => setApplyTarget(row.original)}>
          <CopyPlus className="h-4 w-4" aria-hidden="true" />
          {t('agency.snapshots.apply', { defaultValue: 'Apply' })}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('agency.snapshots.title', { defaultValue: 'Snapshots' })}
        description={t('agency.snapshots.subtitle', {
          defaultValue: 'Capture a workspace’s configuration once, then apply it to any child location.',
        })}
        actions={
          <Button onClick={() => setCaptureOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('agency.snapshots.captureTitle', { defaultValue: 'Capture snapshot' })}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={snapshots ?? []}
        isLoading={isLoading}
        loadingRowCount={4}
        emptyState={
          <EmptyState
            icon={<Camera className="h-10 w-10" />}
            title={t('agency.snapshots.empty', { defaultValue: 'No snapshots yet' })}
            description={t('agency.snapshots.emptyHint', {
              defaultValue: 'Capture your first config snapshot to reuse it across locations.',
            })}
            action={
              <Button onClick={() => setCaptureOpen(true)} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('agency.snapshots.captureTitle', { defaultValue: 'Capture snapshot' })}
              </Button>
            }
          />
        }
      />

      <CaptureSnapshotDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
        locations={locs}
        onSubmit={handleCapture}
        isPending={capture.isPending}
      />

      <ApplySnapshotDialog
        open={!!applyTarget}
        onOpenChange={(o) => {
          if (!o) setApplyTarget(null);
        }}
        snapshot={applyTarget}
        locations={locs}
      />
    </div>
  );
}

export default function SnapshotsPage() {
  return (
    <AgencyGuard>
      <SnapshotsPageInner />
    </AgencyGuard>
  );
}
