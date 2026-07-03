import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PauseCircle, Ban } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Spinner } from '@/components/ui/Spinner';
import { useBreadcrumbLabel } from '@/features/marketing/hooks/useBreadcrumbLabel';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/Select';
import { SocialCampaignCalendar } from './SocialCampaignCalendar';
import { ApprovalQueue } from './ApprovalQueue';
import { CampaignStatusHero } from './CampaignStatusHero';
import { PipelineStats } from './PipelineStats';
import { deriveCampaignState } from './campaignState';
import {
  confirmSocialCampaignPlan,
  getSocialCampaign,
  listSocialCampaignItems,
  reviewSocialCampaignItem,
  setCampaignLifecycle,
  updateSocialCampaign,
  type SocialCampaignStatus,
  type SocialCampaignAutomationMode,
  type SocialCampaignPlanningMode,
} from '../../../features/marketing/api/socialCampaigns.service';

const AUTOMATION_MODES: SocialCampaignAutomationMode[] = ['APPROVAL', 'SEMI_AUTO', 'FULL_AUTO'];
const PLANNING_MODES: SocialCampaignPlanningMode[] = ['AI_PROPOSE', 'AI_FULL', 'USER_TOPICS'];

const STATUS_TONE = {
  DRAFT: 'neutral',
  ACTIVE: 'success',
  PAUSED: 'warning',
  COMPLETED: 'info',
  CANCELLED: 'danger',
} as const;

// Human English fallback so a missing translation never leaks the raw enum
// (DRAFT/ACTIVE/…) into the primary status chip.
const STATUS_LABEL_DEFAULT: Record<SocialCampaignStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export default function SocialCampaignDetailPage() {
  const { t } = useTranslation('marketing');
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('calendar');
  const [cancelOpen, setCancelOpen] = useState(false);

  const campaignQuery = useQuery({
    queryKey: ['marketing', 'social-campaigns', id],
    queryFn: () => getSocialCampaign(id),
    enabled: !!id,
    // While the background planner/generator is working, keep the header + hero live.
    refetchInterval: 15_000,
  });
  useBreadcrumbLabel(campaignQuery.data?.name);
  const itemsQuery = useQuery({
    queryKey: ['marketing', 'social-campaigns', id, 'items'],
    queryFn: () => listSocialCampaignItems(id),
    enabled: !!id,
    refetchInterval: 15_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'social-campaigns', id, 'items'] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'social-campaigns', id] });
  };

  const review = useMutation({
    mutationFn: ({ itemId, action }: { itemId: string; action: 'approve' | 'reject' | 'regenerate' }) =>
      reviewSocialCampaignItem(itemId, action),
    onSuccess: () => { invalidate(); toast.success(t('socialCampaign.itemUpdated', 'Item updated')); },
    onError: () => toast.error(t('socialCampaign.itemUpdateFailed', 'Action failed')),
  });

  const lifecycle = useMutation({
    mutationFn: (action: 'activate' | 'pause' | 'resume' | 'cancel') => setCampaignLifecycle(id, action),
    onSuccess: () => { invalidate(); setCancelOpen(false); toast.success(t('socialCampaign.lifecycleOk', 'Updated')); },
    onError: () => toast.error(t('socialCampaign.lifecycleFailed', 'Action failed')),
  });

  const confirmPlan = useMutation({
    mutationFn: () => confirmSocialCampaignPlan(id),
    onSuccess: () => { invalidate(); toast.success(t('socialCampaign.planConfirmed', 'Plan confirmed')); },
    onError: () => toast.error(t('socialCampaign.planConfirmFailed', 'Action failed')),
  });

  // Retune automation/planning modes AFTER creation. The backend allows a
  // mode-only PATCH while DRAFT/ACTIVE/PAUSED (rejecting completed/cancelled and
  // mid-generation) — surface its BadRequest message verbatim on error.
  const modes = useMutation({
    mutationFn: (payload: { automationMode?: SocialCampaignAutomationMode; planningMode?: SocialCampaignPlanningMode }) =>
      updateSocialCampaign(id, payload),
    onSuccess: () => { invalidate(); toast.success(t('socialCampaign.modesUpdated', 'Modes updated')); },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || t('socialCampaign.modesUpdateFailed', 'Could not update modes')),
  });

  if (campaignQuery.isLoading || !campaignQuery.data) return <Spinner />;
  const c = campaignQuery.data;
  const items = itemsQuery.data ?? [];
  const state = deriveCampaignState(c, items);
  const statusTone = STATUS_TONE[c.status] ?? 'neutral';
  // Only treat as an error when the FIRST load failed (no data at all).
  // react-query keeps the last good list on a background-refetch error, so we
  // keep rendering it rather than blanking the studio.
  const itemsError = itemsQuery.isError && itemsQuery.data === undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title={c.name}
        description={c.goal ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone}>{t(`socialCampaign.status.${c.status}`, STATUS_LABEL_DEFAULT[c.status] ?? c.status)}</Badge>
            {c.status === 'ACTIVE' && (
              <Button variant="secondary" size="sm" loading={lifecycle.isPending} onClick={() => lifecycle.mutate('pause')}>
                <PauseCircle className="h-4 w-4" />
                {t('socialCampaign.pause', 'Pause')}
              </Button>
            )}
            {(c.status === 'ACTIVE' || c.status === 'PAUSED' || c.status === 'DRAFT') && (
              <Button variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={() => setCancelOpen(true)}>
                <Ban className="h-4 w-4" />
                {t('socialCampaign.cancel', 'Cancel')}
              </Button>
            )}
          </div>
        }
      />

      {itemsError ? (
        <Callout tone="danger" title={t('socialCampaign.itemsError', "Couldn't load this campaign's content")}>
          <div className="space-y-2">
            <p>
              {t(
                'socialCampaign.itemsErrorHint',
                "Something went wrong loading the posts. This doesn't affect your live campaign — try again.",
              )}
            </p>
            <Button size="sm" variant="secondary" loading={itemsQuery.isFetching} onClick={() => itemsQuery.refetch()}>
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        </Callout>
      ) : (
        <>
          <CampaignStatusHero
            campaign={c}
            state={state}
            onActivate={() => lifecycle.mutate('activate')}
            onResume={() => lifecycle.mutate('resume')}
            onConfirmPlan={() => confirmPlan.mutate()}
            onGoToApprovals={() => setTab('queue')}
            lifecyclePending={lifecycle.isPending}
            confirmPending={confirmPlan.isPending}
          />

          <PipelineStats state={state} />

          {/* Modes: automation + planning are editable after creation (mode-only PATCH). */}
          {c.status !== 'COMPLETED' && c.status !== 'CANCELLED' && (
            <div className="rounded-xl border border-border bg-surface p-4">
              <h3 className="text-sm font-medium">{t('socialCampaign.modesTitle', 'Modes')}</h3>
              <p className="mt-0.5 text-caption text-muted-foreground">
                {t('socialCampaign.modesHint', 'Change how future posts are handled. Pause the campaign if a post is mid-generation.')}
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-caption font-medium text-muted-foreground">{t('socialCampaign.f.automation', 'Automation')}</span>
                  <Select
                    value={c.automationMode}
                    disabled={modes.isPending}
                    onValueChange={(v) => modes.mutate({ automationMode: v as SocialCampaignAutomationMode })}
                  >
                    <SelectTrigger aria-label={t('socialCampaign.f.automation', 'Automation')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AUTOMATION_MODES.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="space-y-1">
                  <span className="text-caption font-medium text-muted-foreground">{t('socialCampaign.f.planning', 'Planning')}</span>
                  <Select
                    value={c.planningMode}
                    disabled={modes.isPending}
                    onValueChange={(v) => modes.mutate({ planningMode: v as SocialCampaignPlanningMode })}
                  >
                    <SelectTrigger aria-label={t('socialCampaign.f.planning', 'Planning')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLANNING_MODES.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </div>
            </div>
          )}

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="calendar">{t('socialCampaign.tabCalendar', 'Content calendar')}</TabsTrigger>
              <TabsTrigger value="queue" className="gap-1.5">
                {t('socialCampaign.tabQueue', 'Approval queue')}
                {state.needsApproval > 0 && <Badge tone="warning" size="sm">{state.needsApproval}</Badge>}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="calendar">
              <SocialCampaignCalendar
                items={items}
                onRegenerate={(itemId) => review.mutate({ itemId, action: 'regenerate' })}
                regeneratingId={review.isPending ? review.variables?.itemId : null}
              />
            </TabsContent>
            <TabsContent value="queue">
              <ApprovalQueue
                items={items}
                pendingId={review.isPending ? review.variables?.itemId : null}
                pendingAction={review.isPending ? review.variables?.action : null}
                onReview={(itemId, action) => review.mutate({ itemId, action })}
              />
            </TabsContent>
          </Tabs>
        </>
      )}

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('socialCampaign.cancelTitle', 'Cancel this campaign?')}
        description={t('socialCampaign.cancelDesc', 'Scheduled posts stop and the campaign is cancelled. Already-published posts stay live. This cannot be undone.')}
        confirmLabel={t('socialCampaign.cancelConfirm', 'Cancel campaign')}
        cancelLabel={t('common.back', 'Back')}
        tone="danger"
        loading={lifecycle.isPending}
        onConfirm={() => lifecycle.mutate('cancel')}
      />
    </div>
  );
}
