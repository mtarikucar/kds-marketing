import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CheckCircle2, DollarSign, Pencil } from 'lucide-react';
import { useState, useEffect } from 'react';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { fmtDate, fmtDateTime } from '../utils/format';
import { formatMoney, type WorkspaceCurrency } from '../../../lib/money';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Badge,
  Button,
  Skeleton,
  Input,
} from '../../../components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CommissionDetail {
  id: string;
  amount: number | string;
  type: 'SIGNUP' | 'RENEWAL' | 'UPSELL';
  status: 'PENDING' | 'APPROVED' | 'PAID';
  period: string;
  notes?: string | null;
  createdAt: string;
  approvedAt?: string | null;
  paidAt?: string | null;
  marketingUser?: {
    id: string;
    firstName: string;
    lastName: string;
    email?: string;
  };
  tenant?: { id: string; name: string; subdomain?: string } | null;
  lead?: {
    id: string;
    businessName: string;
    contactPerson?: string;
    source?: string;
    status?: string;
    convertedAt?: string | null;
  } | null;
  plan?: {
    id: string;
    name: string;
    displayName: string;
    commissionRate: number | string;
  } | null;
  auditLog?: Array<{
    at: string;
    action: 'approve' | 'pay' | 'amount';
    actorId?: string;
    actorType?: string;
    actorEmail?: string;
    prevStatus?: string;
    nextStatus?: string;
    prevAmount?: string;
    nextAmount?: string;
    actor?: {
      id: string;
      firstName: string;
      lastName: string;
      email?: string;
    } | null;
  }>;
}

// ─── Badge tone helpers ──────────────────────────────────────────────────────

function statusTone(s: string): 'warning' | 'info' | 'success' | 'neutral' {
  switch (s) {
    case 'PENDING':  return 'warning';
    case 'APPROVED': return 'info';
    case 'PAID':     return 'success';
    default:         return 'neutral';
  }
}

function typeTone(t: string): 'primary' | 'success' | 'info' | 'neutral' {
  switch (t) {
    case 'SIGNUP':  return 'primary';
    case 'RENEWAL': return 'success';
    case 'UPSELL':  return 'info';
    default:        return 'neutral';
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  commissionId: string | null;
  onClose: () => void;
  /** The workspace currency — commissions have no per-row currency, so amounts
   *  are formatted in the workspace's currency, matching CommissionsPage's list.
   *  Without this the modal hardcoded ₺ and showed a false symbol on a non-TRY
   *  workspace (the list already uses formatMoney with the dynamic currency). */
  currency?: WorkspaceCurrency;
}

/**
 * Full-screen drill-down for a single commission row. Surfaces the
 * answer to "ne kadar / ne için" — amount, type, calculation
 * (paidAmount × commissionRate), the lead the customer came in on,
 * and an audit timeline showing who approved/paid the row.
 *
 * Manager-only buttons piggyback on the same patch endpoints
 * CommissionsPage already calls; they invalidate the same query keys
 * so the parent table refreshes on close.
 */
export default function CommissionDetailModal({ commissionId, onClose, currency = 'TRY' }: Props) {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<CommissionDetail>({
    queryKey: ['marketing', 'commissions', 'detail', commissionId],
    queryFn: () =>
      marketingApi.get(`/commissions/${commissionId}`).then((r) => r.data),
    enabled: !!commissionId,
  });

  const [editingAmount, setEditingAmount] = useState(false);
  const [draftAmount, setDraftAmount] = useState('');

  // Reset the inline amount editor whenever the opened commission changes. The
  // parent mounts this modal persistently (commissionId is a prop, not a mount
  // gate), so without this a draft amount typed for one commission would carry
  // into the next — and a Save could write it onto the wrong row.
  useEffect(() => {
    setEditingAmount(false);
    setDraftAmount('');
  }, [commissionId]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'commissions'] });
  };

  const approve = useMutation({
    mutationFn: () =>
      marketingApi.patch(`/commissions/${commissionId}/approve`),
    onSuccess: () => {
      invalidate();
      toast.success(t('commission.approved', 'Approved'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message ?? t('commission.approveFailed', 'Approval failed'));
    },
  });

  const markPaid = useMutation({
    mutationFn: () => marketingApi.patch(`/commissions/${commissionId}/pay`),
    onSuccess: () => {
      invalidate();
      toast.success(t('commission.paid', 'Marked as paid'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message ?? t('commission.payFailed', 'Could not mark paid'));
    },
  });

  const updateAmount = useMutation({
    mutationFn: (amount: number) =>
      marketingApi.patch(`/commissions/${commissionId}`, { amount }),
    onSuccess: () => {
      invalidate();
      setEditingAmount(false);
      toast.success(t('commission.amountUpdated', 'Amount updated'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message ?? t('commission.amountUpdateFailed', 'Amount update failed'));
    },
  });

  const amount = data ? Number(data.amount) : 0;
  const commissionRate = data?.plan ? Number(data.plan.commissionRate) : null;
  // paidAmount = amount / rate (reverses the SIGNUP/RENEWAL/UPSELL math)
  const paidAmount =
    commissionRate && commissionRate > 0 ? amount / commissionRate : null;

  const open = !!commissionId;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-6 py-4 border-b border-border">
          <DialogTitle>
            {t('commission.detailTitle', 'Commission detail')}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t('commission.detailDescription', 'Commission details and payment information')}
          </DialogDescription>
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isLoading || !data ? (
            <div className="space-y-3">
              <Skeleton className="h-10 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-32 w-full mt-4" />
            </div>
          ) : (
            <>
              {/* Amount + type + status headline */}
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="font-display text-h1 text-foreground tabular-nums">
                  {formatMoney(amount, currency)}
                </span>
                <Badge tone={typeTone(data.type)}>
                  {t(`commissionType.${data.type}`, data.type)}
                </Badge>
                <Badge tone={statusTone(data.status)}>
                  {t(`commissionStatus.${data.status}`, data.status)}
                </Badge>
                {isManager && data.status === 'PENDING' && !editingAmount && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftAmount(amount.toString());
                      setEditingAmount(true);
                    }}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    {t('commission.editAmount', 'Adjust amount')}
                  </button>
                )}
              </div>

              {/* Inline amount editor */}
              {editingAmount && (
                <div className="mt-3 flex items-center gap-2">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={draftAmount}
                    onChange={(e) => setDraftAmount(e.target.value)}
                    className="w-36"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      const n = Number(draftAmount);
                      if (!Number.isFinite(n) || n < 0) {
                        toast.error(t('commission.amountInvalid', 'Invalid amount'));
                        return;
                      }
                      updateAmount.mutate(n);
                    }}
                    loading={updateAmount.isPending}
                  >
                    {t('common.save', 'Save')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingAmount(false)}
                  >
                    {t('common.cancel', 'Cancel')}
                  </Button>
                </div>
              )}

              {/* Details grid */}
              <dl className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">
                    {t('commission.fields.customer', 'Customer')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-foreground">
                    {data.tenant?.name ?? '—'}
                    {data.tenant?.subdomain && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {data.tenant.subdomain}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t('commission.fields.plan', 'Plan')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-foreground">
                    {data.plan?.displayName ?? '—'}
                    {commissionRate != null && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({(commissionRate * 100).toFixed(1)}%)
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t('commission.fields.period', 'Period')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-foreground">{data.period}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t('commission.fields.calculation', 'Calculation')}
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs text-foreground">
                    {paidAmount != null && commissionRate != null ? (
                      <>
                        {formatMoney(paidAmount, currency)} × {(commissionRate * 100).toFixed(1)}% ={' '}
                        {formatMoney(amount, currency)}
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('commission.fields.calcUnavailable', 'Plan could not be resolved')}
                      </span>
                    )}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">
                    {t('commission.fields.lead', 'Linked lead')}
                  </dt>
                  <dd className="mt-0.5 text-sm text-foreground">
                    {data.lead ? (
                      <span>
                        <span className="font-medium">{data.lead.businessName}</span>
                        {data.lead.source && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t(`source.${data.lead.source}`, data.lead.source)}
                          </span>
                        )}
                        {data.lead.convertedAt && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {fmtDate(data.lead.convertedAt)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('commission.fields.noLead', 'No linked lead')}
                      </span>
                    )}
                  </dd>
                </div>
                {data.notes && (
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">
                      {t('commission.fields.notes', 'Notes')}
                    </dt>
                    <dd className="mt-0.5 text-sm text-foreground">{data.notes}</dd>
                  </div>
                )}
              </dl>

              {/* Audit timeline */}
              <section className="mt-6">
                <h3 className="text-sm font-semibold text-foreground mb-3">
                  {t('commission.auditLog', 'History')}
                </h3>
                <ol className="relative border-s border-border ps-5 space-y-3">
                  <AuditEntry
                    label={t('commission.history.created', 'Commission created')}
                    at={data.createdAt}
                  />
                  {(data.auditLog ?? []).map((entry, idx) => (
                    <AuditEntry
                      key={`${entry.action}-${entry.at}-${idx}`}
                      label={describeAuditEntry(entry, t, currency)}
                      at={entry.at}
                      actorName={
                        entry.actor
                          ? `${entry.actor.firstName} ${entry.actor.lastName}`
                          : entry.actorType === 'SUPERADMIN'
                            ? entry.actorEmail
                              ? `SuperAdmin (${entry.actorEmail})`
                              : 'SuperAdmin'
                            : null
                      }
                    />
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>

        {/* Footer actions — manager only, not shown when PAID */}
        {isManager && data && data.status !== 'PAID' && (
          <DialogFooter className="px-6 py-3 border-t border-border bg-surface-muted">
            {data.status === 'PENDING' && (
              <Button
                onClick={() => approve.mutate()}
                loading={approve.isPending}
              >
                <CheckCircle2 className="h-4 w-4" />
                {t('commission.approve', 'Approve')}
              </Button>
            )}
            {data.status === 'APPROVED' && (
              <Button
                onClick={() => markPaid.mutate()}
                loading={markPaid.isPending}
              >
                <DollarSign className="h-4 w-4" />
                {t('commission.markPaid', 'Mark paid')}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Audit entry ──────────────────────────────────────────────────────────────

function AuditEntry({
  label,
  at,
  actorName,
}: {
  label: string;
  at: string;
  actorName?: string | null;
}) {
  return (
    <li>
      <div className="absolute -start-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-border" />
      <p className="text-sm text-foreground">{label}</p>
      <p className="text-xs text-muted-foreground">
        {fmtDateTime(at)}
        {actorName && (
          <span className="ml-2 text-muted-foreground">— {actorName}</span>
        )}
      </p>
    </li>
  );
}

function describeAuditEntry(
  entry: {
    action: string;
    prevStatus?: string;
    nextStatus?: string;
    prevAmount?: string;
    nextAmount?: string;
  },
  t: any,
  currency: WorkspaceCurrency,
): string {
  if (entry.action === 'approve') {
    return t('commission.history.approved', 'Approved');
  }
  if (entry.action === 'pay') {
    return t('commission.history.paid', 'Marked paid');
  }
  if (entry.action === 'amount') {
    const fmt = (v?: string) => (v == null ? '?' : formatMoney(v, currency));
    return `${t('commission.history.amount', 'Amount changed')} (${fmt(entry.prevAmount)} → ${fmt(entry.nextAmount)})`;
  }
  return entry.action;
}
