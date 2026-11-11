import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import * as api from '@/api/studio';
import type { LaneKind } from '@/api/types';
import { kindLabel } from '@/lib/capabilities';
import { formatMoney } from '@/lib/format';
import {
  contentTypeLabel,
  Region,
  Field,
  StudioError,
  inputClass,
  buttonClass,
  useStudioMutation,
} from './StudioShared';

export function StudioLearned({
  data,
  query,
  lane,
  onLane,
}: {
  data?: api.Overview;
  query: api.Query;
  lane?: LaneKind;
  onLane: (l: LaneKind | undefined) => void;
}) {
  const { t, i18n } = useTranslation();
  const [hypothesis, setHypothesis] = useState(query.hypothesis_id ?? '');
  const h = query.hypothesis_id || hypothesis || data?.hypotheses[0]?.id || '';
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
    <Region name="learned" className="xl:col-span-2">
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
      {data?.lane_support.organic.reason &&
        (data.lane_support.organic.reason === 'connector_reconnect_required' ? (
          <p className="text-sm">
            {t('studio.connectorReconnect')}{' '}
            <Link className="underline" to="/capabilities">
              {t('studio.reconnect')}
            </Link>
          </p>
        ) : (
          <p className="text-sm">{t('studio.connectorUnavailable')}</p>
        ))}
      <ul className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-1">
        {data?.learned.arms.map(({ arm, evidence: rows }) => (
          <li key={arm.id} className="border-b border-border pb-3">
            <p className="text-sm font-medium">
              {data.hypotheses.find((h) => h.id === arm.key.hypothesis_id)?.title} /{' '}
              {contentTypeLabel(t, arm.key.content_type)} / {kindLabel(t, arm.key.channel)}
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
          {c.observed_minor === null
            ? t('studio.notMeasured')
            : formatMoney(c.observed_minor, c.currency, i18n.language)}{' '}
          / {formatMoney(c.cap_minor, c.currency, i18n.language)}
        </p>
      ))}
      {data && (
        <>
          <details>
            <summary className="cursor-pointer font-medium">{t('studio.judgment')}</summary>
            <ul className="my-3 space-y-2 text-sm">
              {data.learned.judgments.map((j) => (
                <li key={j.id}>{j.text}</li>
              ))}
            </ul>
            <form
              className="space-y-3"
              aria-label={t('studio.recordJudgment')}
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
        </>
      )}
      <StudioError error={judgment.error || refresh.error} />
    </Region>
  );
}
