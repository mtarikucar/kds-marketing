import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { pending } from '@/api/studio';
import { Dialog, DialogContent, DialogDescription } from '@/components/ui';
import { useStudioKey } from '../StudioShared';
import { TiktokSlot } from './TiktokSlot';

/** Studio's pending work: whether this TikTok post still waits for its posting screen. */
function usePending() {
  const key = useStudioKey();
  return useQuery({ queryKey: [...key, 'pending'], queryFn: pending, refetchInterval: 30_000 });
}

/**
 * A TikTok post to finish, over the page: the retained posting screen (TikTok's Content Sharing
 * Guidelines), unchanged, in a dialog that closes back to where the person was (`tiktok=` of
 * Paylaşımlar, design 2026-11-19 §2.7.3).
 */
export function TiktokDialog({ id, manage, onClose }: { id: string; manage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const waitingRead = usePending();
  const waiting = !!waitingRead.data?.blockers.some((b) => 'slot' in b.target && b.target.slot === id && b.next_action === 'tiktok_posting_screen');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogDescription className="sr-only">{t('socialAccounts.finishTiktokHelp')}</DialogDescription>
        {!waitingRead.isLoading && <TiktokSlot id={id} manage={manage} waiting={waiting} />}
      </DialogContent>
    </Dialog>
  );
}
