import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Wallet as WalletIcon, Plus, Minus } from 'lucide-react';
import {
  getWallet,
  creditWallet,
  debitWallet,
} from '../../../features/marketing/api/wallet.service';
import { formatMoney, asWorkspaceCurrency } from '../../../lib/money';
import { Card, Button, Input } from '@/components/ui';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  return Array.isArray(msg) ? msg[0] : (msg ?? fallback);
}

/** Store-credit wallet panel for the lead detail page (manager-only money tool). */
export function WalletPanel({ leadId, isManager }: { leadId: string; isManager: boolean }) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'wallet', leadId],
    queryFn: () => getWallet(leadId),
    enabled: !!leadId,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'wallet', leadId] });
  const currency = asWorkspaceCurrency(data?.currency);

  const credit = useMutation({
    mutationFn: () => creditWallet(leadId, Math.round(Number(amount) * 100)),
    onSuccess: () => { invalidate(); setAmount(''); toast.success(t('wallet.toast.credited', { defaultValue: 'Wallet credited' })); },
    onError: (e) => toast.error(apiError(e, t('wallet.toast.failed', { defaultValue: 'Failed' }))),
  });
  const debit = useMutation({
    mutationFn: () => debitWallet(leadId, Math.round(Number(amount) * 100)),
    onSuccess: () => { invalidate(); setAmount(''); toast.success(t('wallet.toast.debited', { defaultValue: 'Wallet debited' })); },
    onError: (e) => toast.error(apiError(e, t('wallet.toast.failed', { defaultValue: 'Failed' }))),
  });

  if (isLoading) return null;
  const balance = data?.balance ?? 0;
  const validAmount = Number(amount) > 0;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <WalletIcon className="h-4 w-4 text-primary" aria-hidden="true" />
          {t('wallet.title', { defaultValue: 'Store credit' })}
        </span>
        <span className="text-lg font-semibold tabular-nums text-primary">{formatMoney(balance / 100, currency)}</span>
      </div>

      {isManager && (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            step="0.01"
            min={0}
            placeholder={t('wallet.amount', { defaultValue: 'Amount' })}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-32"
          />
          <Button size="sm" variant="outline" disabled={!validAmount || credit.isPending} onClick={() => credit.mutate()}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {t('wallet.credit', { defaultValue: 'Credit' })}
          </Button>
          <Button size="sm" variant="outline" disabled={!validAmount || debit.isPending} onClick={() => debit.mutate()}>
            <Minus className="h-3.5 w-3.5" aria-hidden="true" /> {t('wallet.debit', { defaultValue: 'Debit' })}
          </Button>
        </div>
      )}

      {(data?.ledger?.length ?? 0) > 0 && (
        <ul className="space-y-1 border-t border-border pt-2 text-micro">
          {data!.ledger.slice(0, 6).map((e) => (
            <li key={e.id} className="flex items-center justify-between text-muted-foreground">
              <span>{e.note || e.reason}</span>
              <span className={e.delta >= 0 ? 'tabular-nums text-success' : 'tabular-nums text-danger'}>
                {e.delta >= 0 ? '+' : '−'}
                {formatMoney(Math.abs(e.delta) / 100, currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
