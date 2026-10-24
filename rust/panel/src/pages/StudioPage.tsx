import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { getPending } from '@/api/work';
import type { Hypothesis, LaneKind } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { can } from '@/lib/roles';
import { StudioStrategyBar } from './StudioStrategyBar';
import { StudioPlan } from './StudioPlan';
import { StudioToday } from './StudioToday';
import { StudioLearned } from './StudioLearned';
import { StudioLedger } from './StudioLedger';
import { Field, StudioError, inputClass, useStudioKey } from './StudioShared';
export function StudioPage() {
  const { t } = useTranslation();
  const session = useSession();
  const key = useStudioKey();
  const allowed = can(session.data, 'studio.work');
  const manage = can(session.data, 'studio.manage');
  const [hypothesis, setHypothesis] = useState('');
  const [lane, setLane] = useState<LaneKind>();
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [from, setFrom] = useState(() =>
    new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
  );
  const [until, setUntil] = useState(() =>
    new Date(Date.now() + 8 * 86400000).toISOString().slice(0, 10),
  );
  const query: api.Query = {
    hypothesis_id: hypothesis || undefined,
    lane,
    from: `${from}T00:00:00+03:00`,
    until: `${until}T00:00:00+03:00`,
  };
  const overview = useQuery({
    queryKey: [...key, 'overview', query],
    queryFn: () => api.overview(query),
    enabled: allowed && Boolean(from && until),
    refetchInterval: 60_000,
  });
  const work = useQuery({
    queryKey: ['work', 'pending', session.data?.current_workspace],
    queryFn: getPending,
    enabled: allowed,
    refetchInterval: 60_000,
  });
  // Keep the selector's complete choices when the server projects only the selected hypothesis.
  const [choices, setChoices] = useState<Hypothesis[]>([]);
  useEffect(() => {
    if (overview.data && !hypothesis) setChoices(overview.data.hypotheses);
  }, [overview.data, hypothesis]);
  const data = overview.data;
  return (
    <div data-testid="studio" className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">{t('studio.title')}</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="hypothesis">
          <select
            className={inputClass}
            value={hypothesis}
            onChange={(e) => {
              setHypothesis(e.target.value);
              setSelectedSlot(null);
            }}
          >
            <option value="">{t('studio.all')}</option>
            {choices.map((h) => (
              <option key={h.id} value={h.id}>
                {h.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="from">
          <input
            className={inputClass}
            type="date"
            value={from}
            onChange={(e) => {
              if (e.target.value) {
                setFrom(e.target.value);
                setSelectedSlot(null);
              }
            }}
          />
        </Field>
        <Field label="until">
          <input
            className={inputClass}
            type="date"
            value={until}
            onChange={(e) => {
              if (e.target.value) {
                setUntil(e.target.value);
                setSelectedSlot(null);
              }
            }}
          />
        </Field>
      </div>
      {!allowed && <p role="alert">{t('studio.forbidden')}</p>}
      <StudioError error={overview.error} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.2fr)_minmax(0,1fr)]">
        <StudioStrategyBar
          data={data}
          manage={manage}
          propose={can(session.data, 'team.manage')}
          onHypothesis={(id) => {
            setHypothesis(id);
            setSelectedSlot(null);
          }}
        />
        <StudioPlan
          slots={data?.slots ?? []}
          hypotheses={data?.hypotheses ?? []}
          arms={data?.learned.arms.map((a) => a.arm) ?? []}
          onSelect={setSelectedSlot}
        />
        <StudioToday
          data={data}
          selectedSlot={selectedSlot}
          onSelect={setSelectedSlot}
          manage={manage}
          overdue={work.data?.agent.overdue ?? false}
        />
        <StudioLearned
          data={data}
          query={query}
          lane={lane}
          onLane={(l) => {
            setLane(l);
            setSelectedSlot(null);
          }}
          manage={manage}
        />
        <StudioLedger query={query} allowed={allowed} />
      </div>
    </div>
  );
}
