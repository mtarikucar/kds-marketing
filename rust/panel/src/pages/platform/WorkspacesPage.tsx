import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import { listWorkspaces, resumeWorkspace, suspendWorkspace, revokeActivation } from '@/api/platform';
import type { WorkspaceAdminOut } from '@/api/types';
import { QueryState } from '@/components/QueryState';
import { WorkspaceStatusBadge } from '@/components/StatusBadges';
import { Button, DataTable, Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Textarea, EmptyState, PageHeader, toast } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';

export const PLATFORM_WORKSPACES_KEY = ['platform', 'workspaces'] as const;

/** Entitlement-preserving suspension and resumption; payment activation is a separate flow. */
export function WorkspacesPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const workspaces = useQuery({ queryKey: PLATFORM_WORKSPACES_KEY, queryFn: listWorkspaces });

  const [suspending, setSuspending] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const change = useMutation({
    mutationFn: ({ id, reason, revoke }: { id: string; reason?: string; revoke?: boolean }) => revoke ? revokeActivation(id, reason!) : reason === undefined ? resumeWorkspace(id) : suspendWorkspace(id, reason),
    onSuccess: (updated) => {
      setSuspending(null);
      setReason('');
      queryClient.setQueryData<WorkspaceAdminOut[]>(PLATFORM_WORKSPACES_KEY, (list) =>
        list?.map((w) => (w.id === updated.id ? updated : w)),
      );
      toast.success(t('platform.workspaces.changed'));
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });
  const { mutate, isPending, variables } = change;

  const columns = useMemo<ColumnDef<WorkspaceAdminOut, unknown>[]>(
    () => [
      {
        id: 'name',
        header: t('platform.workspaces.columns.name'),
        accessorKey: 'name',
        cell: ({ row }) => <span className="font-medium text-foreground">{row.original.name}</span>,
      },
      {
        id: 'slug',
        header: t('platform.workspaces.columns.slug'),
        accessorKey: 'slug',
        cell: ({ row }) => <span className="font-mono text-caption">{row.original.slug}</span>,
      },
      {
        id: 'owner',
        header: t('platform.workspaces.columns.owner'),
        accessorFn: (w) => w.owner_email ?? '',
        cell: ({ row }) => row.original.owner_email ?? <span className="text-muted-foreground">{t('common.none')}</span>,
      },
      {
        id: 'members',
        header: t('platform.workspaces.columns.members'),
        accessorKey: 'member_count',
        cell: ({ row }) => (
          <span className="tabular-nums">{formatNumber(row.original.member_count, i18n.language)}</span>
        ),
      },
      {
        id: 'status',
        header: t('platform.workspaces.columns.status'),
        accessorKey: 'status',
        cell: ({ row }) => <WorkspaceStatusBadge status={row.original.status} />,
      },
      {
        id: 'created',
        header: t('platform.workspaces.columns.created'),
        accessorKey: 'created_at',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {formatDateTime(row.original.created_at, i18n.language)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const w = row.original;
          const busy = isPending && variables?.id === w.id;
          return (
            <div className="flex justify-end gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={w.status !== 'suspended' || busy}
                onClick={() => mutate({ id: w.id })}
              >
                {t('platform.workspaces.resume')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={w.status !== 'active' || busy}
                onClick={() => { setRevoking(false); setReason(''); setSuspending(w.id); }}
              >
                {t('platform.workspaces.suspend')}
              </Button>
              <Button variant="outline" size="sm" disabled={busy} onClick={()=>{setRevoking(true);setReason('');setSuspending(w.id);}}>{t('platform.payments.revoke')}</Button>
            </div>
          );
        },
      },
    ],
    [t, i18n.language, mutate, isPending, variables],
  );

  return (
    <>
      <PageHeader title={t('platform.workspaces.title')} description={t('platform.workspaces.description')} />
      <QueryState query={workspaces}>
        <DataTable
          columns={columns}
          data={workspaces.data ?? []}
          emptyState={<EmptyState title={t('platform.workspaces.empty')} />}
        />
      </QueryState>
      <Dialog open={suspending !== null} onOpenChange={(open) => { if (!open) setSuspending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t(revoking ? 'platform.payments.revoke' : 'platform.workspaces.suspend')}</DialogTitle>
            <DialogDescription>{t(revoking ? 'platform.payments.reasonHelp' : 'platform.workspaces.reasonHelp')}</DialogDescription>
          </DialogHeader>
          <label htmlFor="suspend-reason">{t('platform.workspaces.reason')}</label>
          <Textarea id="suspend-reason" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
          <DialogFooter>
            <Button disabled={isPending || !reason.trim()} onClick={() => { if (suspending) mutate({ id: suspending, reason: reason.trim(), revoke: revoking }); }}>
              {t('platform.workspaces.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
