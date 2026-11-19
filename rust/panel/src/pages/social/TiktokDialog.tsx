import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription } from '@/components/ui';
import { usePending } from './data';
import { useSocialPlace } from './location';
import { TiktokSlot } from './TiktokSlot';

/**
 * A TikTok post to finish, over the page: the retained posting screen (TikTok's Content Sharing
 * Guidelines), unchanged, in a dialog that closes back to where the person was.
 */
export function TiktokDialog({ id, manage }: { id: string; manage: boolean }) {
  const { t } = useTranslation();
  const [place, go] = useSocialPlace();
  const pending = usePending(true);
  const waiting = !!pending.data?.blockers.some((b) => 'slot' in b.target && b.target.slot === id && b.next_action === 'tiktok_posting_screen');
  return (
    <Dialog open onOpenChange={(open) => { if (!open) go({ ...place, tiktok: undefined }, { replace: true }); }}>
      <DialogContent className="max-w-3xl">
        <DialogDescription className="sr-only">{t('socialAccounts.finishTiktokHelp')}</DialogDescription>
        {!pending.isLoading && <TiktokSlot id={id} manage={manage} waiting={waiting} />}
      </DialogContent>
    </Dialog>
  );
}
