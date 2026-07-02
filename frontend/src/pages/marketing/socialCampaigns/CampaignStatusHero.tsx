import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Rocket,
  Sparkles,
  Loader2,
  ClipboardCheck,
  CheckCircle2,
  CalendarClock,
  PlayCircle,
  PauseCircle,
  XCircle,
  Clock,
  Users,
  Repeat,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Progress } from '@/components/ui/Progress';
import type { SocialCampaign } from '../../../features/marketing/api/socialCampaigns.service';
import type { CampaignPhase, CampaignState } from './campaignState';
import { cadenceSummary, relativeFromNow } from './campaignFormat';

type Tone = 'neutral' | 'info' | 'primary' | 'success' | 'warning' | 'danger';

const TONE_RING: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-muted-foreground',
  info: 'bg-info/10 text-info',
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
};

const TONE_ACCENT: Record<Tone, string> = {
  neutral: 'before:bg-border',
  info: 'before:bg-info',
  primary: 'before:bg-primary',
  success: 'before:bg-success',
  warning: 'before:bg-warning',
  danger: 'before:bg-danger',
};

interface PhaseView {
  tone: Tone;
  icon: ReactNode;
  spin?: boolean;
}

const PHASE_VIEW: Record<CampaignPhase, PhaseView> = {
  draft: { tone: 'neutral', icon: <Rocket className="h-5 w-5" /> },
  planning: { tone: 'info', icon: <Loader2 className="h-5 w-5" />, spin: true },
  awaiting_confirm: { tone: 'primary', icon: <Sparkles className="h-5 w-5" /> },
  generating: { tone: 'info', icon: <Loader2 className="h-5 w-5" />, spin: true },
  needs_approval: { tone: 'warning', icon: <ClipboardCheck className="h-5 w-5" /> },
  running: { tone: 'success', icon: <CalendarClock className="h-5 w-5" /> },
  idle: { tone: 'info', icon: <Clock className="h-5 w-5" /> },
  paused: { tone: 'warning', icon: <PauseCircle className="h-5 w-5" /> },
  completed: { tone: 'success', icon: <CheckCircle2 className="h-5 w-5" /> },
  cancelled: { tone: 'neutral', icon: <XCircle className="h-5 w-5" /> },
};

const MODE_DESC: Record<SocialCampaign['automationMode'], { key: string; def: string }> = {
  APPROVAL: { key: 'socialCampaign.mode.approval', def: 'Publishes only after you approve each post' },
  SEMI_AUTO: { key: 'socialCampaign.mode.semiAuto', def: 'Auto-publishes unless you reject it in time' },
  FULL_AUTO: { key: 'socialCampaign.mode.fullAuto', def: 'Publishes automatically at each scheduled time' },
};

export interface CampaignStatusHeroProps {
  campaign: SocialCampaign;
  state: CampaignState;
  onActivate: () => void;
  onResume: () => void;
  onConfirmPlan: () => void;
  onGoToApprovals: () => void;
  lifecyclePending: boolean;
  confirmPending: boolean;
}

function Fact({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

export function CampaignStatusHero({
  campaign,
  state,
  onActivate,
  onResume,
  onConfirmPlan,
  onGoToApprovals,
  lifecyclePending,
  confirmPending,
}: CampaignStatusHeroProps) {
  const { t, i18n } = useTranslation('marketing');
  const view = PHASE_VIEW[state.phase];
  const now = new Date();

  // Anchor 2024-01-07 is a Sunday at 00:00 UTC; read it back in UTC so the
  // weekday index (0=Sun…6=Sat) is stable for viewers in any timezone.
  const dayShort = [0, 1, 2, 3, 4, 5, 6].map((d) =>
    new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(i18n.language, { weekday: 'short', timeZone: 'UTC' }),
  );
  const cadence = cadenceSummary(campaign.cadence, dayShort);
  const mode = MODE_DESC[campaign.automationMode];

  // SEMI_AUTO parks items in NEEDS_APPROVAL but auto-publishes them unless the
  // user rejects in time — so its review copy must read as "optional veto", not
  // a hard "nothing goes live until you approve" gate (which is APPROVAL mode).
  const semiAutoReview = state.phase === 'needs_approval' && campaign.automationMode === 'SEMI_AUTO';
  const titleKey = semiAutoReview
    ? 'socialCampaign.phase.needs_approval_auto.title'
    : `socialCampaign.phase.${state.phase}.title`;
  const descKey = semiAutoReview
    ? 'socialCampaign.phase.needs_approval_auto.desc'
    : `socialCampaign.phase.${state.phase}.desc`;
  const descN =
    state.phase === 'needs_approval'
      ? state.needsApproval
      : state.phase === 'generating'
        ? state.creating
        : state.total;
  const title = t(titleKey, semiAutoReview ? SEMI_AUTO_REVIEW_TITLE : PHASE_DEFAULT_TITLE[state.phase]);
  const desc = t(descKey, semiAutoReview ? SEMI_AUTO_REVIEW_DESC : PHASE_DEFAULT_DESC[state.phase], { n: descN });

  return (
    <Card
      className={`relative overflow-hidden pl-1 before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-[''] ${TONE_ACCENT[view.tone]}`}
    >
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${TONE_RING[view.tone]}`}>
              <span className={view.spin ? 'animate-spin' : ''}>{view.icon}</span>
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">{title}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{desc}</p>
            </div>
          </div>

          <div className="shrink-0">
            {state.phase === 'draft' && (
              <Button loading={lifecyclePending} onClick={onActivate}>
                <PlayCircle className="h-4 w-4" />
                {t('socialCampaign.activate', 'Activate')}
              </Button>
            )}
            {state.phase === 'awaiting_confirm' && (
              <Button loading={confirmPending} onClick={onConfirmPlan}>
                <Sparkles className="h-4 w-4" />
                {t('socialCampaign.confirmPlan', 'Confirm plan')}
              </Button>
            )}
            {state.phase === 'needs_approval' && (
              <Button variant="secondary" onClick={onGoToApprovals}>
                <ClipboardCheck className="h-4 w-4" />
                {t('socialCampaign.reviewNow', 'Review {{n}}', { n: state.needsApproval })}
              </Button>
            )}
            {state.phase === 'paused' && (
              <Button loading={lifecyclePending} onClick={onResume}>
                <PlayCircle className="h-4 w-4" />
                {t('socialCampaign.resume', 'Resume')}
              </Button>
            )}
          </div>
        </div>

        {/* Fact strip */}
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-3 text-xs">
          <Fact icon={<ShieldCheck className="h-3.5 w-3.5" />} label={t('socialCampaign.factMode', 'Mode')} value={mode ? t(mode.key, mode.def) : campaign.automationMode} />
          {cadence && <Fact icon={<Repeat className="h-3.5 w-3.5" />} label={t('socialCampaign.factCadence', 'Cadence')} value={cadence} />}
          {state.nextScheduledFor && (
            <Fact
              icon={<Clock className="h-3.5 w-3.5" />}
              label={t('socialCampaign.factNext', 'Next post')}
              value={relativeFromNow(state.nextScheduledFor, now, i18n.language)}
            />
          )}
          <Fact
            icon={<Users className="h-3.5 w-3.5" />}
            label={t('socialCampaign.factAccounts', 'Accounts')}
            value={String(campaign.targetAccountIds?.length ?? 0)}
          />
          {campaign.mediaKinds?.length > 0 && (
            <Fact
              icon={<Zap className="h-3.5 w-3.5" />}
              label={t('socialCampaign.factMedia', 'Media')}
              value={campaign.mediaKinds
                .map((k) => t(`socialCampaign.mediaKind.${k}`, MEDIA_KIND_DEFAULT[k] ?? k))
                .join(', ')}
            />
          )}
        </div>

        {/* Progress */}
        {state.total > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {t('socialCampaign.publishedOf', 'Published {{done}} of {{total}}', { done: state.published, total: state.publishableTotal })}
              </span>
              <span className="font-medium text-foreground">{state.publishedPct}%</span>
            </div>
            <Progress value={state.publishedPct} tone={state.failed > 0 ? 'warning' : 'success'} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// SEMI_AUTO review copy: the posts auto-publish unless vetoed, so this is an
// optional review window, not a blocking approval gate.
const SEMI_AUTO_REVIEW_TITLE = 'Publishing soon — review if you want';
const SEMI_AUTO_REVIEW_DESC =
  '{{n}} post(s) will auto-publish at their scheduled time unless you reject them first.';

const MEDIA_KIND_DEFAULT: Record<string, string> = {
  IMAGE: 'Image',
  VIDEO: 'Video',
  CAROUSEL: 'Carousel',
  STORY: 'Story',
  REEL: 'Reel',
  TEXT: 'Text',
};

const PHASE_DEFAULT_TITLE: Record<CampaignPhase, string> = {
  draft: 'Ready to launch',
  planning: 'Planning your content…',
  awaiting_confirm: 'Your plan is ready to review',
  generating: 'Creating content…',
  needs_approval: 'Posts waiting for your approval',
  running: 'Running smoothly',
  idle: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const PHASE_DEFAULT_DESC: Record<CampaignPhase, string> = {
  draft: 'Press Activate and the system starts planning and creating your posts automatically.',
  planning: 'The system is composing your first post now — it will appear here in a moment. No action needed.',
  awaiting_confirm: 'AI proposed a content plan. Confirm it to start generating the copy and visuals.',
  generating: 'Writing copy and generating visuals for {{n}} post(s). This takes a moment.',
  needs_approval: '{{n}} post(s) are ready — review them before they go live.',
  running: 'Everything is on track. Your scheduled posts will publish at their times.',
  idle: 'No posts pending right now — the next one is planned automatically at your cadence.',
  paused: 'Scheduled posts are on hold. Press Resume to continue publishing.',
  completed: 'All planned content has been processed.',
  cancelled: 'This campaign was cancelled.',
};
