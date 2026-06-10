import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { X, CheckCircle2, DollarSign, Pencil } from 'lucide-react';
import { useState } from 'react';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { fmtDate, fmtDateTime } from '../utils/format';

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

const STATUS_BADGE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  PAID: 'bg-emerald-100 text-emerald-800',
};

const TYPE_BADGE: Record<string, string> = {
  SIGNUP: 'bg-indigo-100 text-indigo-800',
  RENEWAL: 'bg-teal-100 text-teal-800',
  UPSELL: 'bg-fuchsia-100 text-fuchsia-800',
};

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

  if (!commissionId) return null;

  const amount = data ? Number(data.amount) : 0;
  const commissionRate = data?.plan ? Number(data.plan.commissionRate) : null;
  // paidAmount = amount / rate (reverses the SIGNUP/RENEWAL/UPSELL math)
  const paidAmount =
    commissionRate && commissionRate > 0 ? amount / commissionRate : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-t-2xl sm:rounded-2xl bg-white shadow-2xl max-h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">
            {t('commission.detailTitle', 'Komisyon detayı')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {isLoading || !data ? (
            <div className="h-40 animate-pulse rounded-lg bg-slate-100" />
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-4xl font-bold text-slate-900">
                  ₺{amount.toFixed(2)}
                </span>
                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${TYPE_BADGE[data.type] ?? 'bg-slate-100 text-slate-700'}`}
                >
                  {t(`commissionType.${data.type}`, data.type)}
                </span>
                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_BADGE[data.status] ?? 'bg-slate-100 text-slate-700'}`}
                >
                  {t(`commissionStatus.${data.status}`, data.status)}
                </span>
                {isManager && data.status === 'PENDING' && !editingAmount && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraftAmount(amount.toString());
                      setEditingAmount(true);
                    }}
                    className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    {t('commission.editAmount', 'Tutarı düzelt')}
                  </button>
                )}
              </div>

              {editingAmount && (
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={draftAmount}
                    onChange={(e) => setDraftAmount(e.target.value)}
                    className="w-32 rounded-md border-slate-300 text-sm focus:border-primary-500 focus:ring-primary-500"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const n = Number(draftAmount);
                      if (!Number.isFinite(n) || n < 0) {
                        toast.error(t('commission.amountInvalid', 'Geçersiz tutar'));
                        return;
                      }
                      updateAmount.mutate(n);
                    }}
                    disabled={updateAmount.isPending}
                    className="rounded-md bg-slate-900 px-3 py-1.5 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
                  >
                    {t('common.save', 'Kaydet')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingAmount(false)}
                    className="text-xs text-slate-500 hover:text-slate-700"
                  >
                    {t('common.cancel', 'Vazgeç')}
                  </button>
                </div>
              )}

              <dl className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
                <div>
                  <dt className="text-slate-500">
                    {t('commission.fields.customer', 'Müşteri')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-slate-900">
                    {data.tenant?.name ?? '—'}
                    {data.tenant?.subdomain && (
                      <span className="ml-2 text-xs text-slate-400">
                        {data.tenant.subdomain}
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">
                    {t('commission.fields.plan', 'Plan')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-slate-900">
                    {data.plan?.displayName ?? '—'}
                    {commissionRate != null && (
                      <span className="ml-2 text-xs text-slate-500">
                        ({(commissionRate * 100).toFixed(1)}%)
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">
                    {t('commission.fields.period', 'Periyot')}
                  </dt>
                  <dd className="mt-0.5 font-medium text-slate-900">{data.period}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">
                    {t('commission.fields.calculation', 'Hesaplama')}
                  </dt>
                  <dd className="mt-0.5 font-mono text-xs text-slate-800">
                    {paidAmount != null && commissionRate != null ? (
                      <>
                        ₺{paidAmount.toFixed(2)} × {(commissionRate * 100).toFixed(1)}% = ₺
                        {amount.toFixed(2)}
                      </>
                    ) : (
                      <span className="text-slate-400">
                        {t('commission.fields.calcUnavailable', 'Plan ilişkilendirilemedi')}
                      </span>
                    )}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-slate-500">
                    {t('commission.fields.lead', 'Bağlı Lead')}
                  </dt>
                  <dd className="mt-0.5 text-sm text-slate-900">
                    {data.lead ? (
                      <span>
                        <span className="font-medium">{data.lead.businessName}</span>
                        {data.lead.source && (
                          <span className="ml-2 text-xs text-slate-500">
                            {t(`source.${data.lead.source}`, data.lead.source)}
                          </span>
                        )}
                        {data.lead.convertedAt && (
                          <span className="ml-2 text-xs text-slate-400">
                            {fmtDate(data.lead.convertedAt)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-slate-400">
                        {t('commission.fields.noLead', 'Lead bağlantısı yok')}
                      </span>
                    )}
                  </dd>
                </div>
                {data.notes && (
                  <div className="sm:col-span-2">
                    <dt className="text-slate-500">
                      {t('commission.fields.notes', 'Notlar')}
                    </dt>
                    <dd className="mt-0.5 text-sm text-slate-700">{data.notes}</dd>
                  </div>
                )}
              </dl>

              <section className="mt-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-3">
                  {t('commission.auditLog', 'Geçmiş')}
                </h3>
                <ol className="relative border-l border-slate-200 pl-5 space-y-3">
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

        {isManager && data && data.status !== 'PAID' && (
          <footer className="border-t border-slate-200 px-6 py-3 flex gap-2 justify-end bg-slate-50">
            {data.status === 'PENDING' && (
              <button
                type="button"
                onClick={() => approve.mutate()}
                disabled={approve.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <CheckCircle2 className="w-4 h-4" />
                {t('commission.approve', 'Onayla')}
              </button>
            )}
            {data.status === 'APPROVED' && (
              <button
                type="button"
                onClick={() => markPaid.mutate()}
                disabled={markPaid.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <DollarSign className="w-4 h-4" />
                {t('commission.markPaid', 'Ödendi işaretle')}
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

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
      <div className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-slate-300" />
      <p className="text-sm text-slate-900">{label}</p>
      <p className="text-xs text-slate-500">
        {fmtDateTime(at)}
        {actorName && (
          <span className="ml-2 text-slate-400">— {actorName}</span>
        )}
      </p>
    </li>
  );
}

function describeAuditEntry(
  entry: { action: string; prevStatus?: string; nextStatus?: string; prevAmount?: string; nextAmount?: string },
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
