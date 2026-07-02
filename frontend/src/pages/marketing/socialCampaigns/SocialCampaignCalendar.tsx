import { useTranslation } from 'react-i18next';
import { CalendarRange, Image as ImageIcon, Play, Loader2, AlertTriangle, RefreshCw, ExternalLink } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  type SocialCampaignItem,
  type SocialCampaignItemMedia,
  type SocialCampaignItemStatus,
} from '../../../features/marketing/api/socialCampaigns.service';
import { relativeFromNow } from './campaignFormat';

const ITEM_TONE: Record<SocialCampaignItemStatus, BadgeProps['tone']> = {
  PLANNED: 'neutral',
  GENERATING: 'info',
  NEEDS_APPROVAL: 'warning',
  APPROVED: 'info',
  SCHEDULED: 'info',
  PUBLISHED: 'success',
  FAILED: 'danger',
  SKIPPED: 'neutral',
};

const STATUS_LABEL: Record<SocialCampaignItemStatus, { key: string; def: string }> = {
  PLANNED: { key: 'socialCampaign.itemStatus.PLANNED', def: 'Planned' },
  GENERATING: { key: 'socialCampaign.itemStatus.GENERATING', def: 'Creating' },
  NEEDS_APPROVAL: { key: 'socialCampaign.itemStatus.NEEDS_APPROVAL', def: 'To review' },
  APPROVED: { key: 'socialCampaign.itemStatus.APPROVED', def: 'Approved' },
  SCHEDULED: { key: 'socialCampaign.itemStatus.SCHEDULED', def: 'Scheduled' },
  PUBLISHED: { key: 'socialCampaign.itemStatus.PUBLISHED', def: 'Published' },
  FAILED: { key: 'socialCampaign.itemStatus.FAILED', def: 'Failed' },
  SKIPPED: { key: 'socialCampaign.itemStatus.SKIPPED', def: 'Skipped' },
};

// Mirrors the backend's REGENERATABLE_STATES — regenerating a SCHEDULED/PUBLISHED
// item is rejected server-side, so we never offer a button that would 400.
const REGENERATABLE = new Set<SocialCampaignItemStatus>(['PLANNED', 'NEEDS_APPROVAL', 'FAILED', 'SKIPPED']);
// Statuses on the path to publishing — where a failed asset means the post will
// go out image-less unless recovered.
const LIVE_PATH = new Set<SocialCampaignItemStatus>(['NEEDS_APPROVAL', 'APPROVED', 'SCHEDULED']);

function localDayKey(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function PostThumb({ media, status }: { media?: SocialCampaignItemMedia; status: SocialCampaignItemStatus }) {
  const base = 'flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border';
  const src = media?.thumbnailUrl ?? media?.url ?? null;

  if (src && (media?.status === 'READY' || !media?.status)) {
    return (
      <div className={`${base} relative bg-surface-muted`}>
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" />
        {media?.type === 'VIDEO' && (
          <span className="absolute inset-0 flex items-center justify-center bg-black/25">
            <Play className="h-5 w-5 text-white" fill="white" />
          </span>
        )}
      </div>
    );
  }
  if (status === 'GENERATING' || media?.status === 'GENERATING' || media?.status === 'QUEUED') {
    return (
      <div className={`${base} animate-pulse bg-surface-muted text-info`}>
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }
  if (media?.status === 'FAILED' || media?.status === 'BLOCKED') {
    return (
      <div className={`${base} bg-danger/5 text-danger`}>
        <AlertTriangle className="h-5 w-5" />
      </div>
    );
  }
  return (
    <div className={`${base} bg-surface-muted text-muted-foreground/50`}>
      <ImageIcon className="h-5 w-5" />
    </div>
  );
}

export interface SocialCampaignCalendarProps {
  items: SocialCampaignItem[];
  onRegenerate?: (itemId: string) => void;
  regeneratingId?: string | null;
}

export function SocialCampaignCalendar({ items, onRegenerate, regeneratingId }: SocialCampaignCalendarProps) {
  const { t, i18n } = useTranslation('marketing');
  const now = new Date();

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<CalendarRange className="h-6 w-6" />}
        title={t('socialCampaign.calendarEmpty', 'No content scheduled yet')}
        description={t(
          'socialCampaign.calendarEmptyHint',
          'When the campaign is active, planned posts appear here as the system creates them.',
        )}
      />
    );
  }

  const dayLabel = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { weekday: 'long', month: 'short', day: 'numeric' });
  const timeLabel = (iso: string) =>
    new Date(iso).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' });

  const byDay = new Map<string, SocialCampaignItem[]>();
  for (const it of [...items].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))) {
    const day = localDayKey(it.scheduledFor);
    const bucket = byDay.get(day) ?? [];
    bucket.push(it);
    byDay.set(day, bucket);
  }

  return (
    <div className="space-y-5">
      {[...byDay.entries()].map(([day, dayItems]) => (
        <div key={day} className="space-y-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CalendarRange className="h-4 w-4 text-muted-foreground" />
            {dayLabel(dayItems[0].scheduledFor)}
          </h3>
          {dayItems.map((it) => {
            const media = it.media?.[0];
            const label = STATUS_LABEL[it.status];
            const failed = it.status === 'FAILED';
            // A media asset can fail AFTER the item already advanced to a publishable
            // state (assets generate async) — surface + recover that too, else the
            // post silently publishes image-less.
            const mediaFailed =
              LIVE_PATH.has(it.status) && (it.media ?? []).some((m) => m.status === 'FAILED' || m.status === 'BLOCKED');
            const showFailure = failed || mediaFailed;
            const canRegen = !!onRegenerate && REGENERATABLE.has(it.status);
            return (
              <Card key={it.id}>
                <CardContent className="flex items-start gap-3 p-3">
                  <PostThumb media={media} status={it.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="line-clamp-2 text-sm text-foreground">
                        {it.caption?.trim() || it.topic || t('socialCampaign.untitled', 'Untitled post')}
                      </p>
                      <Badge tone={ITEM_TONE[it.status]} size="sm">
                        {t(label.key, label.def)}
                      </Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{timeLabel(it.scheduledFor)}</span>
                      <span aria-hidden>·</span>
                      <span>{relativeFromNow(it.scheduledFor, now, i18n.language)}</span>
                      {it.status === 'PUBLISHED' && it.socialPostId && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="inline-flex items-center gap-1 text-success">
                            <ExternalLink className="h-3 w-3" />
                            {t('socialCampaign.live', 'Live')}
                          </span>
                        </>
                      )}
                    </div>
                    {showFailure && (
                      <div className="mt-2 flex items-start gap-2 rounded-md bg-danger/5 px-2 py-1.5 text-xs text-danger">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="line-clamp-2 flex-1">
                          {it.error?.trim() ||
                            (mediaFailed
                              ? t(
                                  'socialCampaign.mediaFailedInline',
                                  'The image failed to generate — this post will go out without media unless you regenerate it.',
                                )
                              : t('socialCampaign.generateFailed', 'Generation failed.'))}
                        </span>
                        {canRegen && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 shrink-0 px-2 text-danger hover:text-danger"
                            loading={regeneratingId === it.id}
                            onClick={() => onRegenerate!(it.id)}
                          >
                            <RefreshCw className="h-3 w-3" />
                            {t('socialCampaign.regenerate', 'Regenerate')}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ))}
    </div>
  );
}
