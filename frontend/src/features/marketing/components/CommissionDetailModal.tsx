import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CheckCircle2, DollarSign, Pencil } from 'lucide-react';
import { useState } from 'react';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { fmtDate, fmtDateTime } from '../utils/format';
import {
  Dialog,
  DialogContent,
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
export default function CommissionDetailModal({ commissionId, onClose }: Props) {
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

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'commissions'] });
  };

  const approve = useMutation({
    mutationFn: () =>
      marketingApi.patch(`/commissions/${commissionId}/approve`),
    onSuccess: () => {
      invalidate();
      toast.success(t('commission.approved', 'Onaylandı'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message ?? t('commission.approveFailed', 'Onay başarısız'));
    },
  });

  const markPaid = useMutation({
    mutationFn: () => marketingApi.patch(`/commissions/${commissionId}/pay`),
    onSuccess: () => {
      invalidate();
      toast.success(t('commission.paid', 'Ödendi olarak işaretlendi'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message ?? t('commission.payFailed', 'Ödeme işaretlenemedi'));
    },
  });

  const updateAmount = useMutation({
    mutationFn: (amount: number) =>
      marketingApi.patch(`/commissions/${commissionId}`, { amount }),
    onSuccess: () => {
      invalidate();
      setEditingAmount(false);
      toast.success(t('commission.amountUpdated', 'Tutar güncellendi'));
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message ?? t('commission.amountUpdateFailed', 'Tutar güncellenemedi'));
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
            {t('commission.detailTitle', 'Komisyon detayı')}
          </DialogTitle>
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
                  ₺{amount.toFixed(2)}
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
                    {t('commission.editAmount', 'Tutarı düzelt')}
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
                        toast.error(t('commission.amountInvalid', 'Geçersiz tutar'));
                        return;
                      }
                      updateAmount.mutate(n);
                    }}
                    loading={updateAmount.isPending}
                  >
                    {t('common.save', 'Kaydet')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingAmount(false)}
                  >
                    {t('common.cancel', 'Vazgeç')}
                  </Button>
                </div>
              )}

              {/* Details grid */}
              <dl className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">
                    {t('commission.fields.customer', 'Müşteri')}
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
                    {t('commission.fields.period', 'Periyot')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-foreground">{data.period}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    {t('commission.fields.calculation', 'Hesaplama')}
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs text-foreground">
                    {paidAmount != null && commissionRate != null ? (
                      <>
                        ₺{paidAmount.toFixed(2)} × {(commissionRate * 100).toFixed(1)}% = ₺
                        {amount.toFixed(2)}
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {t('commission.fields.calcUnavailable', 'Plan ilişkilendirilemedi')}
                      </span>
                    )}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-muted-foreground">
                    {t('commission.fields.lead', 'Bağlı Lead')}
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
                        {t('commission.fields.noLead', 'Lead bağlantısı yok')}
                      </span>
                    )}
                  </dd>
                </div>
                {data.notes && (
                  <div className="sm:col-span-2">
                    <dt className="text-muted-foreground">
                      {t('commission.fields.notes', 'Notlar')}
                    </dt>
                    <dd className="mt-0.5 text-sm text-foreground">{data.notes}</dd>
                  </div>
                )}
              </dl>

              {/* Audit timeline */}
              <section className="mt-6">
                <h3 className="text-sm font-semibold text-foreground mb-3">
                  {t('commission.auditLog', 'Geçmiş')}
                </h3>
                <ol className="relative border-s border-border ps-5 space-y-3">
                  <AuditEntry
                    label={t('commission.history.created', 'Komisyon oluşturuldu')}
                    at={data.createdAt}
                  />
                  {(data.auditLog ?? []).map((entry, idx) => (
                    <AuditEntry
                      key={`${entry.action}-${entry.at}-${idx}`}
                      label={describeAuditEntry(entry, t)}
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
                {t('commission.approve', 'Onayla')}
              </Button>
            )}
            {data.status === 'APPROVED' && (
              <Button
                onClick={() => markPaid.mutate()}
                loading={markPaid.isPending}
              >
                <DollarSign className="h-4 w-4" />
                {t('commission.markPaid', 'Ödendi işaretle')}
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
): string {
  if (entry.action === 'approve') {
    return t('commission.history.approved', 'Onaylandı');
  }
  if (entry.action === 'pay') {
    return t('commission.history.paid', 'Ödendi olarak işaretlendi');
  }
  if (entry.action === 'amount') {
    const prev = entry.prevAmount ?? '?';
    const next = entry.nextAmount ?? '?';
    return `${t('commission.history.amount', 'Tutar değiştirildi')} (₺${prev} → ₺${next})`;
  }
  return entry.action;
}
