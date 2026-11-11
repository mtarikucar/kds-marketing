import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { formatDateTime } from '@/lib/format';
import { buttonClass, StudioError, StudioReadStatus, useStudioKey, useStudioMutation } from '../StudioShared';

/**
 * A post that waits for a person because its connection's own approval setting is on (design
 * 2026-11-10 §7.3, B35): what goes out, when, and "Onayla". Approving releases this revision of
 * the post; it then goes out at its time.
 */
export function ApprovalSlot({ id, manage, waiting }: { id: string; manage: boolean; waiting: boolean }) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  const [done, setDone] = useState(false);
  const detail = useQuery({ queryKey: [...key, 'slot', id], queryFn: () => api.slotGet(id) });
  const data = detail.data;
  const approve = useStudioMutation(() => api.approve({ slot: id }, data!.slot.revision), () => setDone(true));
  const planned = data?.post?.publish_at ?? data?.slot.scheduled_at;
  const at = typeof planned === 'string' ? planned : undefined;
  return <section aria-label={t('socialAccounts.approvalTitle')} className="min-w-0 space-y-4">
    <h2 className="font-semibold">{t('socialAccounts.approvalTitle')}</h2>
    <StudioReadStatus query={detail} />
    {data && <>
      <p className="text-sm text-muted-foreground">{t('socialAccounts.approvalHelp')}</p>
      {at && <time dateTime={at} className="block text-sm">{formatDateTime(at, i18n.language)}</time>}
      {data.piece && <p className="whitespace-pre-wrap rounded-md border border-border p-3 text-sm">{data.piece.text}</p>}
      {data.piece && data.piece.media.length > 0 && <p className="text-xs text-muted-foreground">{t('socialAccounts.materials', { count: data.piece.media.length })}</p>}
      {done
        ? <p role="status" className="text-sm text-success">{t('socialAccounts.approved')}</p>
        : !waiting
          ? <p className="text-sm text-muted-foreground">{t('socialAccounts.notWaiting')}</p>
          : manage
            ? <button type="button" className={buttonClass} disabled={approve.isPending} onClick={() => approve.mutate()}>{t('socialAccounts.approve')}</button>
            : <p role="alert" className="text-sm">{t('studio.forbidden')}</p>}
      <StudioError error={approve.error} />
    </>}
  </section>;
}
