import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { Button, DialogTitle } from '@/components/ui';
import { TiktokPostingScreen, TiktokPostCounters, TiktokPostStatus } from '../StudioTiktok';
import { inputClass, StudioError, StudioReadStatus, useStudioKey } from '../StudioShared';
import { useInvalidatePosts } from '../posts/queries';

/** Cancelling a TikTok post that could not be sent, with a reason asked for at that moment only. */
export function CancelPost({ slotId, revision }: { slotId: string; revision: number }) {
  const { t } = useTranslation();
  const refresh = useInvalidatePosts();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  if (done) return <p role="status" className="text-sm text-muted-foreground">{t('socialAccounts.cancelled')}</p>;
  if (!open) return (
    <>
      <p className="basis-full text-sm text-muted-foreground">{t('studio.notResent')}</p>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t('studio.cancel')}</Button>
    </>
  );
  return (
    <form
      className="flex basis-full flex-wrap items-end gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !reason.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await api.slotCancel(slotId, revision, reason.trim());
          setDone(true);
        } catch (err) {
          setError(err);
        }
        setBusy(false);
        await refresh();
      }}
    >
      <label className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1 text-sm">
        <span>{t('studio.reason')}</span>
        <input className={inputClass} name="reason" required maxLength={2000} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <Button size="sm" variant="destructive" type="submit" loading={busy} disabled={!reason.trim()}>{t('socialAccounts.cancelConfirm')}</Button>
      <Button size="sm" variant="ghost" type="button" onClick={() => { setOpen(false); setReason(''); }}>{t('common.cancel')}</Button>
      {!!error && <div className="basis-full"><StudioError error={error} /></div>}
    </form>
  );
}

/** A TikTok slot's screen: posted, being posted, or its posting screen for a person to fill. */
export function TiktokSlot({ id, manage, waiting }: { id: string; manage: boolean; waiting: boolean }) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const detail = useQuery({ queryKey: [...key, 'slot', id], queryFn: () => api.slotGet(id) });
  const data = detail.data;
  return <section aria-label={t('socialAccounts.finishTiktok')} className="min-w-0 space-y-4">
    <DialogTitle>{t('socialAccounts.finishTiktok')}</DialogTitle>
    <StudioReadStatus query={detail} />
    {data && (['published', 'measured'].includes(data.slot.state)
      ? <TiktokPostCounters slotId={id} />
      : data.attempts.length || !waiting
        ? <TiktokPostStatus slot={data.slot} />
        : manage ? <TiktokPostingScreen key={`${id}-${data.slot.revision}`} slot={data.slot} />
          : <p>{t('studio.forbidden')}</p>)}
    {manage && data?.attempts.some(attempt => attempt.state === 'failed' || attempt.state === 'refused') && <div className="flex flex-wrap gap-2"><CancelPost slotId={id} revision={data.slot.revision} /></div>}
  </section>;
}
