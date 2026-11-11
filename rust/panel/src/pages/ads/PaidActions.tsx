import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { listCapabilities } from '@/api/capabilities';
import { minorDigits, parseMinor } from '@/lib/format';
import {
  contentTypeLabel,
  Field,
  StudioError,
  StudioReadStatus,
  inputClass,
  buttonClass,
  useStudioKey,
  useStudioMutation,
} from '../StudioShared';

export function PaidActions({ data, manage }: { data: api.Overview; manage: boolean }) {
  const { t, i18n } = useTranslation();
  const [budgetError, setBudgetError] = useState(false);
  const key = useStudioKey();
  const [cap, setCap] = useState('');
  const [arm, setArm] = useState('');
  const [set, setSet] = useState('');
  const capabilities = useQuery({
    queryKey: [...key, 'ad-accounts'],
    queryFn: () => listCapabilities({ kind: 'meta_ads' }),
  });
  const adsets = useQuery({
    queryKey: [...key, 'adsets', cap],
    queryFn: () => api.adsetsList(cap),
    enabled: Boolean(cap),
  });
  const bind = useStudioMutation(() =>
    api.adsetBind({
      hypothesis_id: data.learned.arms.find((a) => a.arm.id === arm)!.arm.key.hypothesis_id,
      arm_id: arm,
      capability_id: cap,
      adset_id: set,
      request_key: crypto.randomUUID(),
    }),
  );
  // The daily budget is typed in major units of its currency (`1.500` / `1500,50`).
  const move = useStudioMutation((input: { binding: string; minor: number; currency: string }) =>
    api.budgetMove({
      binding_id: input.binding,
      daily_budget_minor: input.minor,
      currency: input.currency,
      request_key: crypto.randomUUID(),
    }),
  );
  return (
    <div className="space-y-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">{t('studio.budgetHelp')}</p>
      <details>
        <summary className="cursor-pointer text-sm font-medium">{t('studio.bind')}</summary>
        <form
          className="mt-3 space-y-3"
          aria-label={t('studio.bind')}
          onSubmit={(e) => {
            e.preventDefault();
            bind.mutate();
          }}
        >
          <StudioReadStatus query={capabilities} />
          <StudioReadStatus query={adsets} />
          <Field label="account">
            <select
              required
              className={inputClass}
              value={cap}
              onChange={(e) => {
                setCap(e.target.value);
                setSet('');
              }}
            >
              <option value="">—</option>
              {capabilities.data?.map((c) => (
                <option key={c.capability.id} value={c.capability.id}>
                  {c.capability.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="externalSet">
            <select
              required
              className={inputClass}
              value={set}
              onChange={(e) => setSet(e.target.value)}
            >
              <option value="">—</option>
              {adsets.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.status})
                </option>
              ))}
            </select>
          </Field>
          <Field label="arm">
            <select
              required
              className={inputClass}
              value={arm}
              onChange={(e) => setArm(e.target.value)}
            >
              <option value="">—</option>
              {data.learned.arms
                .filter((a) => a.arm.key.lane === 'paid')
                .map(({ arm: a }) => (
                  <option key={a.id} value={a.id}>
                    {data.hypotheses.find((h) => h.id === a.key.hypothesis_id)?.title} /{' '}
                    {contentTypeLabel(t, a.key.content_type)}
                  </option>
                ))}
            </select>
          </Field>
          <button className={buttonClass} disabled={!set || !arm || bind.isPending}>
            {t('studio.bind')}
          </button>
        </form>
      </details>
      {manage && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('studio.budgetMove')}</summary>
          <form
            className="mt-3 space-y-3"
            aria-label={t('studio.budgetMove')}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const currency = String(f.get('currency'));
              const minor = parseMinor(String(f.get('amount')), minorDigits(currency), i18n.language);
              setBudgetError(minor === null || minor <= 0);
              if (minor === null || minor <= 0) return;
              move.mutate({ binding: String(f.get('binding')), minor, currency });
            }}
          >
            <Field label="binding">
              <select required name="binding" className={inputClass}>
                <option value="">—</option>
                {data.bindings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.account_id} / {b.adset_id}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="dailyBudget">
              <input
                className={inputClass}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                aria-invalid={budgetError || undefined}
                required
              />
              {budgetError && <p role="alert" className="text-xs text-destructive">{t('studio.invalidBudget')}</p>}
            </Field>
            <Field label="currency">
              <input
                className={inputClass}
                name="currency"
                pattern="[A-Z]{3}"
                maxLength={3}
                required
                defaultValue={
                  data.learned.spend_vs_cap.find((c) => c.lane === 'paid')?.currency ?? ''
                }
              />
            </Field>
            <button className={buttonClass} disabled={move.isPending}>
              {t('studio.budgetMove')}
            </button>
          </form>
        </details>
      )}
      <StudioError error={bind.error || move.error} />
      {(bind.isSuccess || move.isSuccess) && <p role="status">{t('studio.success')}</p>}
    </div>
  );
}
