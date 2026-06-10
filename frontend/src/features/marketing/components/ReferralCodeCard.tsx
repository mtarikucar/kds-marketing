import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Copy, Link as LinkIcon, RefreshCw, Tag } from 'lucide-react';
import marketingApi from '../api/marketingApi';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';

interface ReferralStats {
  referralCode: string | null;
  referralCodeUpdatedAt: string | null;
  referralLeadCount: number;
  referralWonCount: number;
  lifetimeCommissionAmount: number | string;
  lifetimeCommissionCount: number;
}

/**
 * Marketer's own referral-code summary. Lives at the top of
 * MarketingDashboardPage. Shows the code itself in big mono type
 * (easy to read aloud), one-click copy of either the bare code or
 * the share-link, and the lifetime stats — leads-attributed and
 * total commission earned across every status.
 *
 * Regenerate is manager-only, hidden for REP. Rotation
 * intentionally bricks any in-flight cookies pointing at the old
 * code; the confirm() dialog spells that out.
 */
export default function ReferralCodeCard() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const { data, isLoading } = useQuery<ReferralStats>({
    queryKey: ['marketing', 'dashboard', 'referral-stats'],
    queryFn: () =>
      marketingApi.get('/dashboard/referral-stats').then((r) => r.data),
  });

  const regenerate = useMutation({
    mutationFn: () => marketingApi.post('/dashboard/regenerate-referral-code'),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['marketing', 'dashboard', 'referral-stats'],
      });
      toast.success(t('referral.regenerated', 'Kodunuz yenilendi'));
    },
    onError: () => {
      toast.error(t('referral.regenerateFailed', 'Yenileme başarısız'));
    },
  });

  const [copyHint, setCopyHint] = useState<string | null>(null);

  const code = data?.referralCode ?? null;
  const shareLink = code
    ? `${window.location.origin}/?ref=${encodeURIComponent(code)}`
    : null;

  const copy = async (value: string, hint: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyHint(hint);
      setTimeout(() => setCopyHint(null), 1500);
    } catch {
      toast.error(t('referral.copyFailed', 'Panoya kopyalanamadı'));
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="h-24 animate-pulse rounded-lg bg-slate-100" />
      </div>
    );
  }

  if (!code) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        {t(
          'referral.noCode',
          'Henüz bir referans kodunuz yok. Yöneticinizden bir kod tahsis etmesini isteyin.',
        )}
      </div>
    );
  }

  const amount = Number(data?.lifetimeCommissionAmount ?? 0);

  return (
    <div className="rounded-2xl border border-primary-200 bg-gradient-to-r from-primary-50 to-white p-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm text-primary-700">
            <Tag className="w-4 h-4" />
            <span className="font-medium">
              {t('referral.yourCode', 'Sizin referans kodunuz')}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <code className="rounded-lg bg-white border border-primary-200 px-3 py-2 font-mono text-2xl font-bold tracking-wider text-primary-900">
              {code}
            </code>
            <button
              type="button"
              onClick={() => copy(code, 'code')}
              className="inline-flex items-center gap-1 rounded-md bg-white border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
              data-testid="referral-copy-code"
            >
              <Copy className="w-3.5 h-3.5" />
              {copyHint === 'code'
                ? t('referral.copied', 'Kopyalandı')
                : t('referral.copyCode', 'Kodu kopyala')}
            </button>
            {shareLink && (
              <button
                type="button"
                onClick={() => copy(shareLink, 'link')}
                className="inline-flex items-center gap-1 rounded-md bg-white border border-slate-200 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                data-testid="referral-copy-link"
              >
                <LinkIcon className="w-3.5 h-3.5" />
                {copyHint === 'link'
                  ? t('referral.copied', 'Kopyalandı')
                  : t('referral.copyLink', 'Linki kopyala')}
              </button>
            )}
          </div>
          {shareLink && (
            <p className="mt-3 text-xs text-slate-500 break-all">{shareLink}</p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            {t(
              'referral.hint',
              'Bu link/kod ile yapılan abonelik satışlarından komisyon kazanırsınız (ilk satış + yenilemeler + yükseltmeler).',
            )}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3 lg:flex-shrink-0">
          <div className="rounded-lg bg-white border border-primary-100 px-4 py-3 text-center">
            <div className="text-2xl font-bold text-slate-900">
              {data?.referralLeadCount ?? 0}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              {t('referral.statsLeads', 'Toplam Lead')}
            </div>
          </div>
          <div className="rounded-lg bg-white border border-primary-100 px-4 py-3 text-center">
            <div className="text-2xl font-bold text-emerald-700">
              {data?.referralWonCount ?? 0}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              {t('referral.statsWon', 'Kazanılan')}
            </div>
          </div>
          <div className="rounded-lg bg-white border border-primary-100 px-4 py-3 text-center">
            <div className="text-2xl font-bold text-primary-700">
              ₺{amount.toFixed(2)}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-slate-500">
              {t('referral.statsCommission', 'Toplam Komisyon')}
            </div>
          </div>
        </div>
      </div>

      {isManager && (
        <div className="mt-4 pt-4 border-t border-primary-100 flex items-center justify-end">
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  t(
                    'referral.regenerateConfirm',
                    'Eski kod artık çalışmayacak ve paylaştığınız linkler kırılacak. Devam edilsin mi?',
                  ),
                )
              ) {
                regenerate.mutate();
              }
            }}
            disabled={regenerate.isPending}
            className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900 disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {t('referral.regenerate', 'Kodumu yenile')}
          </button>
        </div>
      )}
    </div>
  );
}
