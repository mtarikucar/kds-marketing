import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { openCampaign } from '@/api/ads';
import { listCapabilities } from '@/api/capabilities';
import type { BudgetItemOut } from '@/api/types';
import { MoneyInput } from '@/components/forms';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Field,
  Input,
  Textarea,
} from '@/components/ui';
import { formatMoney } from '@/lib/format';
import { inputClass } from '../StudioShared';
import {
  AD_ACCOUNT_KINDS,
  LinkedinTargetingNotice,
  NoHardCapNotice,
  X_WATCH_MINUTES,
  CampaignError,
  useAdsKey,
  useCampaignMutation,
  validEnd,
} from './CampaignShared';

export function OpenCampaignDialog({
  general,
  held,
  onClose,
}: {
  general: BudgetItemOut | undefined;
  /** What open campaigns already hold of the general ad budget. */
  held: number;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const key = useAdsKey();
  const [requestKey] = useState(() => crypto.randomUUID());
  const [goal, setGoal] = useState('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [account, setAccount] = useState('');
  const currency = general?.item.unit.kind === 'currency' ? general.item.unit.value : 'TRY';
  const accounts = useQuery({
    queryKey: [...key, 'accounts'],
    // Every ad account a campaign can be built on, whatever its platform.
    queryFn: () => listCapabilities({ group: 'ads' }),
    select: (rows) => rows.filter((row) => row.capability.kind_key in AD_ACCOUNT_KINDS),
  });
  const valid =
    goal.trim() &&
    amount !== null &&
    amount > 0 &&
    Number.isFinite(Date.parse(start)) &&
    (!end || validEnd(start, end));
  const open = useCampaignMutation(
    () =>
      openCampaign({
        request_key: requestKey,
        goal: goal.trim(),
        budget_minor: amount!,
        start_at: new Date(start).toISOString(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(account ? { account } : {}),
        ...(end ? { end_at: new Date(end).toISOString() } : {}),
      }),
    (c) => {
      onClose();
      navigate(`/ads?campaign=${encodeURIComponent(c.id)}`);
    },
  );
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('adCampaigns.open')}</DialogTitle>
          <DialogDescription>{t('adCampaigns.invalid')}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) open.mutate();
          }}
        >
          <CampaignError error={open.error} currency={currency} />
          <Field label={t('adCampaigns.goal')} required>
            {(ids) => (
              <Textarea id={ids.id} required value={goal} onChange={(e) => setGoal(e.target.value)} />
            )}
          </Field>
          <Field
            label={t('adCampaigns.budget')}
            required
            hint={
              general
                ? t('adCampaigns.remaining', {
                    amount: formatMoney(Math.max(0, general.remaining - held), currency, i18n.language),
                  })
                : t('adCampaigns.noBudget')
            }
          >
            {(ids) => (
              <MoneyInput
                id={ids.id}
                describedBy={ids.describedBy}
                required
                currency={currency}
                minor={amount}
                onChange={setAmount}
              />
            )}
          </Field>
          <Field label={t('adCampaigns.start')} required>
            {(ids) => (
              <Input
                className="min-w-0 max-w-full"
                id={ids.id}
                type="datetime-local"
                required
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            )}
          </Field>
          <Field label={t('adCampaigns.title')}>
            {(ids) => <Input id={ids.id} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label={t('adCampaigns.account')}>
            {(ids) => (
              <select
                id={ids.id}
                className={inputClass}
                value={account}
                onChange={(e) => setAccount(e.target.value)}
              >
                <option value="">{t('adCampaigns.agentChooses')}</option>
                {accounts.data?.map(({ capability: c }) => (
                  <option key={c.id} value={c.id}>
                    {`${c.name} · ${AD_ACCOUNT_KINDS[c.kind_key]}`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {accounts.data?.some((row) => row.capability.id === account && row.capability.kind_key === 'linkedin_ads') && (
            <LinkedinTargetingNotice />
          )}
          {accounts.data?.some((row) => row.capability.id === account && row.capability.kind_key === 'x_ads') && (
            <NoHardCapNotice platform={AD_ACCOUNT_KINDS.x_ads} minutes={X_WATCH_MINUTES} />
          )}
          <Field label={t('adCampaigns.end')}>
            {(ids) => (
              <Input
                className="min-w-0 max-w-full"
                id={ids.id}
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                min={start || undefined}
              />
            )}
          </Field>
          <Button type="submit" disabled={!valid} loading={open.isPending}>
            {t('adCampaigns.open')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
