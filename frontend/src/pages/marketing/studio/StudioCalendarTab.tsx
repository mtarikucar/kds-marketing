import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import marketingApi from '../../../features/marketing/api/marketingApi';
import ContentCalendarPage from '../contentCalendar/ContentCalendarPage';
import { createSocialCampaign } from '../../../features/marketing/api/socialCampaigns.service';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import { UpgradeCallout } from './UpgradeCallout';
import type { SocialAccount } from '../social/types';

/**
 * The Growth Studio's calendar tab: the full month calendar plus the flagship
 * "Generate weekly plan" flow. One click provisions a REAL one-week
 * SocialCampaign (APPROVAL + AI_PROPOSE) — the pipeline that actually plans AI
 * topics, generates copy + media, queues each item for approval and publishes
 * on approve. (The old WeeklyPlan dialog died in the 2026-07 trim: its
 * "Approve" button only flipped a status flag — nothing was ever scheduled or
 * published, breaking the exact promise the dialog made.)
 */
export default function StudioCalendarTab() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const navigate = useNavigate();
  // The weekly plan provisions a SocialCampaign (POST /social-campaigns) — gated
  // by 'socialCampaigns' on the backend. Without this check the button fires and
  // silently 403s; instead we hide the CTA and prompt an upgrade.
  const { has } = useEntitlements();
  const canGenerate = has('socialCampaigns');

  const generate = useMutation({
    mutationFn: async () => {
      // Fetch the connected accounts INSIDE the mutation (same key/endpoint as
      // the Social Planner, so usually a cache hit via fetchQuery) — resolving
      // them up front would let a fast click provision a campaign with zero
      // targets when the accounts query hadn't landed yet.
      const accountsData = await qc.fetchQuery({
        queryKey: ['marketing', 'social', 'accounts'],
        queryFn: () =>
          marketingApi.get('/social-planner/accounts').then((r) => r.data as SocialAccount[]),
      });
      const accounts: SocialAccount[] = Array.isArray(accountsData) ? accountsData : [];
      const start = new Date();
      const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      return createSocialCampaign({
        name: t('weekly.campaignName', 'Weekly plan — {{date}}', {
          date: start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        }),
        // APPROVAL + AI_PROPOSE: the AI drafts the week, the user approves item
        // by item, and ONLY then anything publishes — the promised UX, for real.
        automationMode: 'APPROVAL',
        planningMode: 'AI_PROPOSE',
        cadence: {
          perWeek: 5,
          daysOfWeek: [1, 2, 3, 4, 5],
          timeOfDay: '09:00',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        targetAccountIds: accounts.map((a) => a.id),
        mediaKinds: ['IMAGE'],
      });
    },
    onSuccess: (sc) => {
      qc.invalidateQueries({ queryKey: ['marketing', 'social-campaigns'] });
      qc.invalidateQueries({ queryKey: ['content-calendar'] });
      toast.success(
        t('weekly.provisioned', 'Your week is being planned — review and approve each draft here.'),
      );
      navigate(`/social-campaigns/${sc.id}`);
    },
    onError: () => toast.error(t('weekly.error', 'Could not generate a plan')),
  });

  return (
    <div className="space-y-4">
      {!canGenerate && <UpgradeCallout />}
      <ContentCalendarPage
        embedded
        onGenerateWeeklyPlan={canGenerate ? () => generate.mutate() : undefined}
      />
    </div>
  );
}
