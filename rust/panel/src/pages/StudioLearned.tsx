import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { listCapabilities } from '@/api/capabilities';
import type { LaneKind } from '@/api/types';
import {
  Region,
  Field,
  StudioError,
  inputClass,
  buttonClass,
  useStudioKey,
  useStudioMutation,
} from './StudioShared';

function PaidActions({ data, manage }: { data: api.Overview; manage: boolean }) {
  const { t } = useTranslation();
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
  const move = useStudioMutation((f: FormData) =>
    api.budgetMove({
      binding_id: String(f.get('binding')),
      daily_budget_minor: Number(f.get('amount')),
      currency: String(f.get('currency')),
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
          onSubmit={(e) => {
            e.preventDefault();
            bind.mutate();
          }}
        >
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
                    {a.key.content_type}
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
            onSubmit={(e) => {
              e.preventDefault();
              move.mutate(new FormData(e.currentTarget));
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
                type="number"
                min={1}
                step={1}
                max={Number.MAX_SAFE_INTEGER}
                required
              />
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
      <StudioError error={capabilities.error || adsets.error || bind.error || move.error} />
      {(bind.isSuccess || move.isSuccess) && <p role="status">{t('studio.success')}</p>}
    </div>
  );
}
export function StudioLearned({
  data,
  query,
  lane,
  onLane,
  manage,
}: {
  data?: api.Overview;
  query: api.Query;
  lane?: LaneKind;
  onLane: (l: LaneKind | undefined) => void;
  manage: boolean;
}) {
  const { t } = useTranslation();
  const [hypothesis, setHypothesis] = useState(query.hypothesis_id ?? '');
  const h = query.hypothesis_id || hypothesis || data?.hypotheses[0]?.id || '';
  const trend = useStudioMutation((f: FormData) =>
    api.trendRecord({
      hypothesis_id: h,
      channel: String(f.get('channel')),
      summary: String(f.get('summary')),
      source_url: String(f.get('url')) || undefined,
      observed_at: new Date().toISOString(),
      request_key: crypto.randomUUID(),
    }),
  );
  const judgment = useStudioMutation((f: FormData) =>
    api.judgmentRecord({
      hypothesis_id: h,
      text: String(f.get('text')),
      evidence_ids: f.getAll('evidence').map(String),
      request_key: crypto.randomUUID(),
    }),
  );
  const refresh = useStudioMutation(() => api.learned(query));
  const evidence =
    data?.learned.arms.filter((a) => a.arm.key.hypothesis_id === h).flatMap((a) => a.evidence) ??
    [];
  const chooseHypothesis = (
    <Field label="entryHypothesis">
      <select
        className={inputClass}
        value={h}
        onChange={(e) => setHypothesis(e.target.value)}
        required
        disabled={Boolean(query.hypothesis_id)}
      >
        {data?.hypotheses.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <Region name="learned">
      <div className="flex flex-wrap gap-2">
        <button
          className={buttonClass}
          aria-pressed={lane === 'organic'}
          onClick={() => onLane(lane === 'organic' ? undefined : 'organic')}
        >
          {t('studio.organic')}
        </button>
        {data?.lane_support.paid.visible && (
          <button
            className={buttonClass}
            aria-pressed={lane === 'paid'}
            onClick={() => onLane(lane === 'paid' ? undefined : 'paid')}
          >
            {t('studio.paid')}
          </button>
        )}
        <button
          className={buttonClass}
          disabled={!data || refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {t('studio.refresh')}
        </button>
      </div>
      {data?.lane_support.organic.reason && (
        <p className="text-sm">{t('studio.connectorUnavailable')}</p>
      )}
      <ul className="space-y-3">
        {data?.learned.arms.map(({ arm, evidence: rows }) => (
          <li key={arm.id}>
            <p className="text-sm font-medium">
              {data.hypotheses.find((h) => h.id === arm.key.hypothesis_id)?.title} /{' '}
              {arm.key.content_type} / {arm.key.channel}
            </p>
            <p className="text-sm text-muted-foreground">
              {rows.length
                ? `${Math.round(arm.weight * 100)}% · ${t('studio.evidence')}: ${rows.length}`
                : t('studio.noEvidence')}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('studio.context')}</p>
      {data?.learned.spend_vs_cap.map((c, i) => (
        <p key={i} className="text-sm">
          {t('studio.spend')} ({t(`studio.${c.lane}`)}):{' '}
          {c.observed_minor ?? t('studio.notMeasured')} / {c.cap_minor} {c.currency}{' '}
          <span className="text-xs">({t('studio.minorUnits')})</span>
        </p>
      ))}
      {data && (
        <>
          <details>
            <summary className="cursor-pointer font-medium">{t('studio.trend')}</summary>
            <ul className="my-3 space-y-2 text-sm">
              {data.learned.trends.map((s) => (
                <li key={s.id}>{s.summary}</li>
              ))}
            </ul>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                trend.mutate(new FormData(e.currentTarget));
              }}
            >
              {chooseHypothesis}
              <Field label="channel">
                <input className={inputClass} name="channel" defaultValue="x" required />
              </Field>
              <Field label="summary">
                <textarea className={inputClass} name="summary" required maxLength={4000} />
              </Field>
              <Field label="sourceUrl">
                <input className={inputClass} name="url" type="url" />
              </Field>
              <button className={buttonClass} disabled={!h || trend.isPending}>
                {t('studio.recordTrend')}
              </button>
            </form>
          </details>
          <details>
            <summary className="cursor-pointer font-medium">{t('studio.judgment')}</summary>
            <ul className="my-3 space-y-2 text-sm">
              {data.learned.judgments.map((j) => (
                <li key={j.id}>{j.text}</li>
              ))}
            </ul>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                judgment.mutate(new FormData(e.currentTarget));
              }}
            >
              {chooseHypothesis}
              <Field label="judgment">
                <textarea className={inputClass} name="text" required maxLength={4000} />
              </Field>
              <fieldset className="space-y-2">
                <legend className="text-sm">{t('studio.evidence')}</legend>
                {evidence.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 text-xs">
                    <input type="checkbox" name="evidence" value={e.id} />
                    {e.id}
                  </label>
                ))}
              </fieldset>
              {!evidence.length && <p className="text-sm">{t('studio.noEvidence')}</p>}
              <button className={buttonClass} disabled={!evidence.length || judgment.isPending}>
                {t('studio.recordJudgment')}
              </button>
            </form>
          </details>
          {data.lane_support.paid.visible && <PaidActions data={data} manage={manage} />}
        </>
      )}
      <StudioError error={trend.error || judgment.error || refresh.error} />
    </Region>
  );
}
