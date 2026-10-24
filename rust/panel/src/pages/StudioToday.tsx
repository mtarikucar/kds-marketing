import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import {
  Region,
  Field,
  Reason,
  StudioError,
  inputClass,
  buttonClass,
  useStudioKey,
  useStudioMutation,
} from './StudioShared';
import type { LaneKind } from '@/api/types';

function SlotEditor({ id, close }: { id: string; close: () => void }) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const detail = useQuery({ queryKey: [...key, 'slot', id], queryFn: () => api.slotGet(id) });
  const [file, setFile] = useState<File>();
  const [media, setMedia] = useState<api.Media[]>([]);
  const upload = useStudioMutation(async () => {
    if (!file) return;
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const out = await api.fileUpload({
      filename: file.name,
      mime: file.type,
      content: { kind: 'bytes_base64', data },
      request_key: crypto.randomUUID(),
    });
    setMedia((old) => [...old, { kind: 'file', id: out.id }]);
  });
  const submit = useStudioMutation(
    (form: FormData) =>
      api.pieceSubmit(id, {
        expected_revision: detail.data!.slot.revision,
        request_key: crypto.randomUUID(),
        text: String(form.get('text')),
        media: [...(detail.data!.piece?.media ?? []), ...media],
        adaptations: detail.data!.piece?.adaptations ?? {},
      }),
    () => setMedia([]),
  );
  const cancel = useStudioMutation((form: FormData) =>
    api.slotCancel(id, detail.data!.slot.revision, String(form.get('reason'))),
  );
  const data = detail.data;
  return (
    <div className="space-y-3 rounded-md border border-primary p-3" data-testid="slot-detail">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{data?.hypothesis.title ?? t('studio.detail')}</h3>
        <button className={buttonClass} onClick={close}>
          {t('studio.close')}
        </button>
      </div>
      <StudioError error={detail.error} />
      {data && (
        <>
          <p className="text-sm">
            {t('studio.brandRules')}: {data.brand_rules.identity.voice}
          </p>
          <ul className="text-xs">
            {data.brand_rules.prohibitions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="text-xs">
            {t(`studio.${data.slot.state}`)} · {t('studio.evidence')}: {data.measurements.length}
          </p>
          {['planned', 'ready'].includes(data.slot.state) && (
            <>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit.mutate(new FormData(e.currentTarget));
                }}
              >
                <Field label="text">
                  <textarea
                    key={`${id}-${data.slot.revision}`}
                    className={inputClass}
                    name="text"
                    rows={5}
                    defaultValue={data.piece?.text ?? ''}
                  />
                </Field>
                <Field label="upload">
                  <input
                    className={inputClass}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,video/mp4"
                    onChange={(e) => setFile(e.target.files?.[0])}
                  />
                </Field>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={!file || upload.isPending}
                  onClick={() => upload.mutate()}
                >
                  {t('studio.upload')}
                </button>
                {media.length > 0 && (
                  <p role="status">
                    {t('studio.uploaded')} ({media.length})
                  </p>
                )}
                <button
                  className={`${buttonClass} w-full`}
                  disabled={submit.isPending || upload.isPending}
                >
                  {t('studio.submit')}
                </button>
              </form>
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  cancel.mutate(new FormData(e.currentTarget));
                }}
              >
                <Field label="reason">
                  <input className={inputClass} name="reason" required maxLength={2000} />
                </Field>
                <button className={buttonClass} disabled={cancel.isPending}>
                  {t('studio.cancel')}
                </button>
              </form>
            </>
          )}
          {data.slot.state === 'retired' && <p>{t('studio.retirement')}</p>}
        </>
      )}
      <StudioError error={upload.error || submit.error || cancel.error} />
    </div>
  );
}
export function StudioToday({
  data,
  selectedSlot,
  onSelect,
  manage,
  overdue,
}: {
  data?: api.Overview;
  selectedSlot: string | null;
  onSelect: (id: string | null) => void;
  manage: boolean;
  overdue: boolean;
}) {
  const { t } = useTranslation();
  const [lane, setLane] = useState<LaneKind>('organic');
  const [required, setRequired] = useState<boolean>();
  const approve = useStudioMutation(
    ({ target, revision }: { target: api.Target; revision: number }) =>
      api.approve(target, revision),
  );
  const policy = useStudioMutation(() =>
    api.policySet(
      lane,
      required ?? data!.control.lanes[lane]?.requires_human_approval ?? false,
      data!.control.revision,
    ),
  );
  const brake = useStudioMutation(() =>
    api.brake(!data!.control.lanes[lane]?.brake_engaged, lane, data!.control.revision),
  );
  const refresh = useStudioMutation(() => api.pending());
  return (
    <Region name="today">
      <div className="flex flex-wrap items-center gap-2">
        {overdue && (
          <p className="rounded bg-warning-subtle px-2 py-1 text-sm">{t('studio.agentWaiting')}</p>
        )}
        <button
          className={buttonClass}
          disabled={!data || refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {t('studio.refresh')}
        </button>
      </div>
      <ul className="space-y-3">
        {data?.today.slots.map(({ slot, overdue }) => (
          <li key={slot.id} className="space-y-2 border-b border-border pb-3">
            <div className="flex flex-wrap justify-between gap-2">
              <button className={`${buttonClass} text-start`} onClick={() => onSelect(slot.id)}>
                {data.hypotheses.find((h) => h.id === slot.chain.hypothesis_id)?.title ??
                  t('studio.detail')}
              </button>
              <span className="text-sm">{t(`studio.${slot.state}`)}</span>
            </div>
            {overdue && slot.state === 'planned' && (
              <p className="text-xs">{t('studio.agentWaiting')}</p>
            )}
            {data.today.blockers
              .filter((b) => 'slot' in b.target && b.target.slot === slot.id)
              .map((b, i) => (
                <Reason key={i} reason={b.reason} />
              ))}
            {manage && data.today.approvals.some((a) => 'slot' in a && a.slot === slot.id) && (
              <button
                className={buttonClass}
                disabled={approve.isPending}
                onClick={() =>
                  approve.mutate({ target: { slot: slot.id }, revision: slot.revision })
                }
              >
                {t('studio.approve')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!data?.today.slots.length && (
        <p className="text-sm text-muted-foreground">{t('studio.emptyToday')}</p>
      )}
      {data?.slots
        .filter(
          (s) =>
            !data.today.slots.some((p) => p.slot.id === s.id) &&
            (s.state === 'retired' ||
              data.today.blockers.some((b) => 'slot' in b.target && b.target.slot === s.id)),
        )
        .map((s) => (
          <div key={s.id} className="space-y-2">
            <button className={buttonClass} onClick={() => onSelect(s.id)}>
              {t(`studio.${s.state}`)}
            </button>
            {data.today.blockers
              .filter((b) => 'slot' in b.target && b.target.slot === s.id)
              .map((b, i) => (
                <Reason key={i} reason={b.reason} />
              ))}
          </div>
        ))}
      {data?.today.budget_moves.map((m) => (
        <div key={m.id} className="space-y-2 border-b border-border pb-3">
          <p className="text-sm">
            {t('studio.dailyBudget')}: {m.daily_budget_minor} {m.currency} ·{' '}
            {t(m.state === 'unknown' ? 'studio.budgetUnknown' : `studio.${m.state}`)}
          </p>
          {data.today.blockers
            .filter((b) => 'budget_move' in b.target && b.target.budget_move === m.id)
            .map((b, i) => (
              <Reason key={i} reason={b.reason} />
            ))}
          {manage &&
            data.today.approvals.some((a) => 'budget_move' in a && a.budget_move === m.id) && (
              <button
                className={buttonClass}
                disabled={approve.isPending}
                onClick={() =>
                  approve.mutate({ target: { budget_move: m.id }, revision: m.revision })
                }
              >
                {t('studio.approve')}
              </button>
            )}
        </div>
      ))}
      {data?.today.paid_alerts.map((a) => (
        <div key={a.binding_id}>
          <Reason reason={a.reason} />
          {a.residual_provider_exposure && <p className="text-sm">{t('studio.exposure')}</p>}
        </div>
      ))}
      {selectedSlot && (
        <SlotEditor key={selectedSlot} id={selectedSlot} close={() => onSelect(null)} />
      )}
      {manage && data && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('studio.policy')}</summary>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              policy.mutate();
            }}
          >
            <Field label="channel">
              <select
                className={inputClass}
                value={lane}
                onChange={(e) => {
                  const next = e.target.value as LaneKind;
                  setLane(next);
                  setRequired(data.control.lanes[next]?.requires_human_approval ?? false);
                }}
              >
                <option value="organic">{t('studio.organic')}</option>
                {data.lane_support.paid.visible && <option value="paid">{t('studio.paid')}</option>}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={required ?? data.control.lanes[lane]?.requires_human_approval ?? false}
                onChange={(e) => setRequired(e.target.checked)}
              />
              {t('studio.requiresApproval')}
            </label>
            <button className={buttonClass} disabled={policy.isPending}>
              {t('studio.savePolicy')}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={brake.isPending}
              onClick={() => brake.mutate()}
            >
              {t(
                data.control.lanes[lane]?.brake_engaged ? 'studio.laneRelease' : 'studio.laneBrake',
              )}
            </button>
          </form>
        </details>
      )}
      <StudioError error={approve.error || policy.error || brake.error || refresh.error} />
    </Region>
  );
}
