import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/Card';
import type { CampaignState } from './campaignState';
import type { SocialCampaignItemStatus } from '../../../features/marketing/api/socialCampaigns.service';

type Tone = 'neutral' | 'info' | 'primary' | 'warning' | 'success' | 'danger';

const DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground',
  info: 'bg-info',
  primary: 'bg-primary',
  warning: 'bg-warning',
  success: 'bg-success',
  danger: 'bg-danger',
};

// The pipeline buckets, in the order content flows through them. SKIPPED is
// included so rejected / brand-safety-blocked posts stay visible and the tiles
// reconcile with the total (they're excluded from the progress bar denominator).
const BUCKETS: { key: SocialCampaignItemStatus; tone: Tone; labelKey: string; def: string }[] = [
  { key: 'PLANNED', tone: 'neutral', labelKey: 'socialCampaign.stat.planned', def: 'Planned' },
  { key: 'GENERATING', tone: 'info', labelKey: 'socialCampaign.stat.generating', def: 'Creating' },
  { key: 'NEEDS_APPROVAL', tone: 'warning', labelKey: 'socialCampaign.stat.needsApproval', def: 'To review' },
  { key: 'SCHEDULED', tone: 'primary', labelKey: 'socialCampaign.stat.scheduled', def: 'Scheduled' },
  { key: 'PUBLISHED', tone: 'success', labelKey: 'socialCampaign.stat.published', def: 'Published' },
  { key: 'FAILED', tone: 'danger', labelKey: 'socialCampaign.stat.failed', def: 'Failed' },
  { key: 'SKIPPED', tone: 'neutral', labelKey: 'socialCampaign.stat.skipped', def: 'Skipped' },
];

export function PipelineStats({ state }: { state: CampaignState }) {
  const { t } = useTranslation('marketing');
  if (state.total === 0) return null;
  // flex-wrap + grow-to-fill keeps every row fully filled (no empty separator
  // cells) whatever the bucket count / breakpoint.
  return (
    <Card>
      <CardContent className="flex flex-wrap gap-px overflow-hidden rounded-lg bg-border p-0">
        {BUCKETS.map((b) => {
          const count = state.counts[b.key] ?? 0;
          const active = count > 0;
          return (
            <div key={b.key} className="flex min-w-[104px] flex-1 flex-col gap-1 bg-surface p-3">
              <div className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${active ? DOT[b.tone] : 'bg-border-strong'}`} />
                <span className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t(b.labelKey, b.def)}
                </span>
              </div>
              <span className={`text-xl font-semibold tabular-nums ${active ? 'text-foreground' : 'text-muted-foreground/50'}`}>
                {count}
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
