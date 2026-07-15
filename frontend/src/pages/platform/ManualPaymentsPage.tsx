import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Inbox } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { usePlatformAuthStore } from '../../store/platformAuthStore';
import platformApi from '../../features/platform/api/platformApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { DataTable } from '@/components/ui/DataTable';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Textarea } from '@/components/ui/Textarea';

interface ManualOrder {
  id: string;
  providerRef: string;
  workspaceId: string;
  workspace?: { name?: string; slug?: string };
  package?: { name: string };
  billingCycle?: string;
  addOnCode?: string;
  amount: number | string;
  currency: string;
  createdAt: string;
}

const rejectSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to reject'),
});
type RejectFormValues = z.infer<typeof rejectSchema>;

function fmtAmount(o: ManualOrder): string {
  return `${Number(o.amount).toLocaleString()} ${o.currency}`;
}
function workspaceName(o: ManualOrder): string {
  return o.workspace?.name ?? o.workspaceId;
}

/**
 * Manual bank-transfer queue: orders sit in AWAITING_TRANSFER until the
 * operator matches the incoming wire by its MKT-… reference and approves —
 * approval rides the same idempotent settlement path the PSP webhooks use.
 */
export default function ManualPaymentsPage() {
  const { isAuthenticated } = usePlatformAuthStore();
  const queryClient = useQueryClient();

  const [approveTarget, setApproveTarget] = useState<ManualOrder | null>(null);
  const [rejectTarget, setRejectTarget] = useState<ManualOrder | null>(null);

  const { data: orders, isLoading } = useQuery<ManualOrder[]>({
    queryKey: ['platform', 'payments', 'awaiting'],
    queryFn: () => platformApi.get('/payments').then((r) => r.data),
    refetchInterval: 30_000,
    // Don't fetch (or poll) until authenticated — preserves the original
    // no-request-before-redirect behavior now that the guard sits in the layout.
    enabled: isAuthenticated,
  });

  const approve = useMutation({
    mutationFn: (orderId: string) => platformApi.post(`/payments/${orderId}/approve`),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'payments'] });
      if (data.settled) toast.success('Payment approved — package activated');
      else toast.warning(`Not settled: ${data.reason}`);
      setApproveTarget(null);
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? 'Approve failed'),
  });

  const reject = useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason: string }) =>
      platformApi.post(`/payments/${orderId}/reject`, { reason }),
    onSuccess: ({ data }) => {
      queryClient.invalidateQueries({ queryKey: ['platform', 'payments'] });
      // Mirror approve: settleFailure returns { settled: false } when the order
      // was already settled (e.g. a concurrent PSP success won the race) — a
      // blanket success toast would tell the operator a paid order was rejected.
      if (data.settled) toast.success('Order rejected');
      else toast.warning('Not rejected — the order was already settled. Refresh the queue.');
      setRejectTarget(null);
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? 'Reject failed'),
  });

  const rejectForm = useForm<RejectFormValues>({
    resolver: zodResolver(rejectSchema),
    mode: 'onBlur',
    defaultValues: { reason: '' },
  });

  // Reset the reason field whenever a new reject target opens.
  useEffect(() => {
    if (rejectTarget) rejectForm.reset({ reason: '' });
  }, [rejectTarget, rejectForm]);

  const onReject: SubmitHandler<RejectFormValues> = (values) => {
    if (!rejectTarget) return;
    reject.mutate({ orderId: rejectTarget.id, reason: values.reason.trim() });
  };

  const columns = useMemo<ColumnDef<ManualOrder, unknown>[]>(
    () => [
      {
        accessorKey: 'providerRef',
        header: 'Reference',
        cell: ({ getValue }) => (
          <span className="font-mono text-xs">{getValue<string>()}</span>
        ),
      },
      {
        id: 'workspace',
        header: 'Workspace',
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="font-medium text-foreground">{workspaceName(row.original)}</div>
            <div className="text-xs text-muted-foreground">{row.original.workspace?.slug}</div>
          </div>
        ),
      },
      {
        id: 'item',
        header: 'Item',
        cell: ({ row }) => {
          const o = row.original;
          return (
            <span className="text-muted-foreground">
              {o.package ? `${o.package.name} (${o.billingCycle})` : o.addOnCode}
            </span>
          );
        },
      },
      {
        id: 'amount',
        header: 'Amount',
        cell: ({ row }) => (
          <span className="font-medium tabular-nums text-foreground">{fmtAmount(row.original)}</span>
        ),
      },
      {
        accessorKey: 'createdAt',
        header: 'Requested',
        cell: ({ getValue }) => (
          <span className="text-xs text-muted-foreground">
            {new Date(getValue<string>()).toLocaleString()}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const o = row.original;
          return (
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                disabled={approve.isPending}
                onClick={() => setApproveTarget(o)}
              >
                Approve
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={reject.isPending}
                onClick={() => setRejectTarget(o)}
              >
                Reject
              </Button>
            </div>
          );
        },
      },
    ],
    [approve.isPending, reject.isPending],
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Manual payments"
        description="Bank-transfer orders awaiting operator approval."
      />

      <DataTable
        columns={columns}
        data={orders ?? []}
        isLoading={isLoading}
        emptyState={
          <EmptyState
            icon={<Inbox className="h-10 w-10" />}
            title="No transfers waiting"
            description="Manual bank-transfer orders will appear here when submitted."
          />
        }
      />

      {/* Approve confirmation */}
      <ConfirmDialog
        open={!!approveTarget}
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
        title="Approve payment"
        description={
          approveTarget
            ? `Approve ${fmtAmount(approveTarget)} for "${workspaceName(approveTarget)}" (ref ${approveTarget.providerRef})? This activates the package.`
            : undefined
        }
        confirmLabel="Approve"
        loading={approve.isPending}
        onConfirm={() => approveTarget && approve.mutate(approveTarget.id)}
      />

      {/* Reject dialog — reason is required and recorded on the order. */}
      <Dialog
        open={!!rejectTarget}
        onOpenChange={(open) => {
          if (!open) setRejectTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject transfer</DialogTitle>
            <DialogDescription>
              {rejectTarget
                ? `Reject the transfer for "${workspaceName(rejectTarget)}" (ref ${rejectTarget.providerRef})? The reason is recorded on the order.`
                : null}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={rejectForm.handleSubmit(onReject)} className="space-y-4">
            <Field label="Reason" error={rejectForm.formState.errors.reason?.message} required>
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  rows={3}
                  placeholder="Why is this transfer being rejected?"
                  {...rejectForm.register('reason')}
                />
              )}
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRejectTarget(null)}
                disabled={reject.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" loading={reject.isPending}>
                Reject
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
