import { useTranslation } from 'react-i18next';
import {
  CheckCircle2, Check, RefreshCw, X, Image as ImageIcon, Play, Clock, Loader2, AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { type SocialCampaignItem } from '../../../features/marketing/api/socialCampaigns.service';
import { relativeFromNow } from './campaignFormat';

/** Larger media preview so the reviewer can actually judge the post — and is
 *  never asked to approve a creative they cannot see. Mirrors the calendar's
 *  PostThumb: real image only when READY, a spinner while it's still rendering,
 *  and an explicit failure state (with Approve disabled) when it failed. */
function ReviewMedia({ item }: { item: SocialCampaignItem }) {
  const media = item.media?.[0];
  const src = media?.thumbnailUrl ?? media?.url ?? null;
  const base = 'flex aspect-square w-full max-w-[112px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border sm:w-28';

  if (src && (media?.status === 'READY' || !media?.status)) {
    return (
      <div className={`${base} relative bg-surface-muted`}>
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
        {media?.type === 'VIDEO' && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25">
            <Play className="h-6 w-6 text-white" fill="white" />
          </span>
        )}
      </div>
    );
  }
  if (media?.status === 'QUEUED' || media?.status === 'GENERATING') {
    return (
      <div className={`${base} animate-pulse bg-surface-muted text-info`}>
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (media?.status === 'FAILED' || media?.status === 'BLOCKED') {
    return (
      <div className={`${base} bg-danger/5 text-danger`}>
        <AlertTriangle className="h-6 w-6" />
      </div>
    );
  }
  return (
    <div className={`${base} bg-surface-muted text-muted-foreground/50`}>
      <ImageIcon className="h-6 w-6" />
    </div>
  );
}

/** True when the item's (first) media asset is still being generated. */
function mediaPending(item: SocialCampaignItem): boolean {
  const s = item.media?.[0]?.status;
  return s === 'QUEUED' || s === 'GENERATING';
}
/** True when the item's (first) media asset failed / was blocked. */
function mediaFailed(item: SocialCampaignItem): boolean {
  const s = item.media?.[0]?.status;
  return s === 'FAILED' || s === 'BLOCKED';
}

export interface ApprovalQueueProps {
  items: SocialCampaignItem[];
  onReview: (itemId: string, action: 'approve' | 'reject' | 'regenerate') => void;
  pendingId?: string | null;
  pendingAction?: 'approve' | 'reject' | 'regenerate' | null;
}

export function ApprovalQueue({ items, onReview, pendingId, pendingAction }: ApprovalQueueProps) {
  const { t, i18n } = useTranslation('marketing');
  const now = new Date();
  const queue = items.filter((it) => it.status === 'NEEDS_APPROVAL');

  if (queue.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="h-6 w-6" />}
        title={t('socialCampaign.queueEmpty', 'Nothing waiting for approval')}
        description={t(
          'socialCampaign.queueEmptyHint',
          'Posts that need your review will appear here before they go live.',
        )}
      />
    );
  }

  return (
    <div className="space-y-3">
      {queue.map((it) => {
        const busy = pendingId === it.id;
        const loadingFor = (a: 'approve' | 'reject' | 'regenerate') => busy && pendingAction === a;
        const failedMedia = mediaFailed(it);
        const pendingMedia = mediaPending(it);
        return (
          <Card key={it.id}>
            <CardContent className="flex flex-col gap-4 p-4 sm:flex-row">
              <ReviewMedia item={it} />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  <span>{new Date(it.scheduledFor).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  <span aria-hidden>·</span>
                  <span>{relativeFromNow(it.scheduledFor, now, i18n.language)}</span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">
                  {it.caption?.trim() || it.topic || t('socialCampaign.untitled', 'Untitled post')}
                </p>
                {it.caption && it.topic && (
                  <p className="mt-1 text-xs italic text-muted-foreground">{it.topic}</p>
                )}
                {/* Never let the reviewer approve a creative they can't see. */}
                {(pendingMedia || failedMedia) && (
                  <div className={`mt-2 flex items-center gap-1.5 text-xs ${failedMedia ? 'text-danger' : 'text-info'}`}>
                    {failedMedia ? (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    )}
                    <span>
                      {failedMedia
                        ? t('socialCampaign.mediaFailed', 'Image failed — regenerate before it goes live')
                        : t('socialCampaign.mediaPreparing', 'Preparing the image…')}
                    </span>
                  </div>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" loading={loadingFor('approve')} disabled={busy || failedMedia} onClick={() => onReview(it.id, 'approve')}>
                    <Check className="h-4 w-4" />
                    {t('socialCampaign.approve', 'Approve')}
                  </Button>
                  <Button size="sm" variant="secondary" loading={loadingFor('regenerate')} disabled={busy} onClick={() => onReview(it.id, 'regenerate')}>
                    <RefreshCw className="h-4 w-4" />
                    {t('socialCampaign.regenerate', 'Regenerate')}
                  </Button>
                  <Button size="sm" variant="ghost" loading={loadingFor('reject')} disabled={busy} onClick={() => onReview(it.id, 'reject')}>
                    <X className="h-4 w-4" />
                    {t('socialCampaign.reject', 'Reject')}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
