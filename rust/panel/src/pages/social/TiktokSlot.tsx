import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { TiktokPostingScreen, TiktokPostCounters, TiktokPostStatus } from '../StudioTiktok';
import { buttonClass, Field, inputClass, StudioError, StudioReadStatus, useStudioKey, useStudioMutation } from '../StudioShared';

export function TiktokSlot({ id, manage, waiting }: { id: string; manage: boolean; waiting: boolean }) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const detail = useQuery({ queryKey: [...key, 'slot', id], queryFn: () => api.slotGet(id) });
  const data = detail.data;
  const cancel = useStudioMutation((form: FormData) => api.slotCancel(id, data!.slot.revision, String(form.get('reason'))));
  return <section aria-label={t('socialAccounts.finishTiktok')} className="min-w-0 space-y-4">
    <h2 className="font-semibold">{t('socialAccounts.finishTiktok')}</h2>
    <StudioReadStatus query={detail} />
    {data && (['published', 'measured'].includes(data.slot.state)
      ? <TiktokPostCounters slotId={id} />
      : data.attempts.length || !waiting
        ? <TiktokPostStatus slot={data.slot} />
        : manage ? <TiktokPostingScreen key={`${id}-${data.slot.revision}`} slot={data.slot} />
          : <p>{t('studio.forbidden')}</p>)}
    {data?.attempts.at(-1)?.state === 'unknown' && data.attempts.at(-1)?.outcome?.status === 'observed' && <p className="text-sm">{t('studio.processing')}</p>}
    {manage && data?.attempts.some(attempt => attempt.state === 'failed' || attempt.state === 'refused') && <form className="space-y-3" onSubmit={event => { event.preventDefault(); if (!cancel.isPending) cancel.mutate(new FormData(event.currentTarget)); }}>
      <p className="text-sm">{t('studio.notResent')}</p>
      <Field label="reason"><input className={inputClass} name="reason" required maxLength={2000} /></Field>
      <button className={buttonClass} disabled={cancel.isPending}>{t('studio.cancel')}</button>
      <StudioError error={cancel.error} />
    </form>}
  </section>;
}
