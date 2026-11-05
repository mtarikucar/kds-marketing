import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import {
  Region,
  Field,
  StudioError,
  inputClass,
  buttonClass,
  useStudioMutation,
} from './StudioShared';
export function StudioStrategyBar({
  data,
  manage,
  propose,
  onHypothesis,
}: {
  data?: api.Overview;
  manage: boolean;
  propose: boolean;
  onHypothesis: (id: string) => void;
}) {
  const { t } = useTranslation();
  const brake = useStudioMutation(() =>
    api.brake(!data?.control.brake_engaged, null, data!.control.revision),
  );
  const proposal = useStudioMutation((form: FormData) =>
    api.hypothesisPropose({
      title: String(form.get('title')),
      segment_key: String(form.get('segment')),
      angle: String(form.get('angle')),
      channel: String(form.get('channel')),
      metric: String(form.get('metric')),
      prior_confidence: Number(form.get('prior')),
      cadence: {},
    }),
  );
  const [open, setOpen] = useState(false);
  return (
    <Region name="strategy" className="text-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {data && (
            <>
              <p className="text-sm text-muted-foreground">
                {t('studio.version')} {data.strategy.number}
              </p>
              <p className="text-base font-medium">{data.goals.objective}</p>
              <ul className="mt-2 flex flex-wrap gap-3 text-sm">
                {data.goals.kpis.map((k) => (
                  <li key={k.name}>
                    {k.name}: {k.target}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        {data && manage && (
          <button
            className={`${buttonClass} text-danger`}
            disabled={brake.isPending}
            onClick={() => brake.mutate()}
          >
            {t(data.control.brake_engaged ? 'studio.release' : 'studio.brake')}
          </button>
        )}
      </div>
      <StudioError error={brake.error} />
      <details>
      <summary className="cursor-pointer py-1 text-sm font-medium">{t('studio.workbench.hypotheses', { defaultValue: 'Hipotezleri göster' })}</summary>
      <ul className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-1">
        {data?.hypotheses.map((h) => (
          <li key={h.id} className="min-w-0">
            <div className="flex justify-between gap-2 text-sm">
              <button
                className="text-start underline decoration-primary/40 underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onHypothesis(h.id)}
              >
                {h.title}
              </button>
              <span>{Math.round((h.derived_confidence ?? h.prior_confidence) * 100)}%</span>
            </div>
            <div
              role="meter"
              aria-label={`${h.title} ${t('studio.confidence')}`}
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={h.derived_confidence ?? h.prior_confidence}
              className="my-2 h-px overflow-hidden bg-border"
            >
              <div className="h-full bg-foreground" style={{ width: `${Math.min(100, Math.max(0, (h.derived_confidence ?? h.prior_confidence) * 100))}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {h.metric} ·{' '}
              {t(h.derived_confidence == null ? 'studio.priorLabel' : 'studio.derived')}
            </p>
          </li>
        ))}
      </ul>
      {data && propose && (
        <>
          <button className={`${buttonClass} self-start justify-self-end`} aria-expanded={open} onClick={() => setOpen(!open)}>
            {t('studio.proposal')}
          </button>
          {open && (
            <form
              className="col-span-full grid gap-4 border-t border-border pt-4 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                proposal.mutate(new FormData(e.currentTarget));
              }}
            >
              {(['titleField', 'segment', 'angle', 'channel', 'metric'] as const).map(
                (label, i) => (
                  <Field key={label} label={label}>
                    <input
                      className={inputClass}
                      name={['title', 'segment', 'angle', 'channel', 'metric'][i]}
                      required
                      defaultValue={label === 'channel' ? 'x' : ''}
                    />
                  </Field>
                ),
              )}
              <Field label="prior">
                <input
                  className={inputClass}
                  name="prior"
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  defaultValue="0.5"
                  required
                />
              </Field>
              <button className={buttonClass} disabled={proposal.isPending}>
                {t('studio.save')}
              </button>
              <StudioError error={proposal.error} />
              {proposal.isSuccess && <p role="status">{t('studio.success')}</p>}
            </form>
          )}
        </>
      )}
      </details>
    </Region>
  );
}
