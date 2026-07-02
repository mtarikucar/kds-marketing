import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PageHeader } from '@/components/ui/PageHeader';
import { Spinner } from '@/components/ui/Spinner';
import { useBreadcrumbLabel } from '@/features/marketing/hooks/useBreadcrumbLabel';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { SocialCampaignCalendar } from './SocialCampaignCalendar';
import { ApprovalQueue } from './ApprovalQueue';
import {
  confirmSocialCampaignPlan,
  getSocialCampaign,
  listSocialCampaignItems,
  reviewSocialCampaignItem,
  setCampaignLifecycle,
} from '../../../features/marketing/api/socialCampaigns.service';

export default function SocialCampaignDetailPage() {
  const { t } = useTranslation('marketing');
  const { id = '' } = useParams();
  const queryClient = useQueryClient();

  const campaignQuery = useQuery({
    queryKey: ['marketing', 'social-campaigns', id],
    queryFn: () => getSocialCampaign(id),
    enabled: !!id,
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
    onSuccess: () => { invalidate(); toast.success(t('socialCampaign.lifecycleOk', 'Updated')); },
    onError: () => toast.error(t('socialCampaign.lifecycleFailed', 'Action failed')),
  });

  const confirmPlan = useMutation({
    mutationFn: () => confirmSocialCampaignPlan(id),
    onSuccess: () => { invalidate(); toast.success(t('socialCampaign.planConfirmed', 'Plan confirmed')); },
    onError: () => toast.error(t('socialCampaign.planConfirmFailed', 'Action failed')),
  });

  if (campaignQuery.isLoading || !campaignQuery.data) return <Spinner />;
  const c = campaignQuery.data;
  const items = itemsQuery.data ?? [];
  const awaitingPlanConfirm =
    c.planningMode === 'AI_PROPOSE' && items.some((i) => i.status === 'PLANNED');

  return (
    <div className="space-y-6">
      <PageHeader
        title={c.name}
        description={c.goal ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">{c.status}</Badge>
            {awaitingPlanConfirm ? (
              <Button loading={confirmPlan.isPending} onClick={() => confirmPlan.mutate()}>
                {t('socialCampaign.confirmPlan', 'Confirm plan')}
              </Button>
            ) : null}
            {c.status === 'ACTIVE' ? (
              <Button variant="secondary" loading={lifecycle.isPending} onClick={() => lifecycle.mutate('pause')}>
                {t('socialCampaign.pause', 'Pause')}
              </Button>
            ) : c.status === 'PAUSED' ? (
              <Button loading={lifecycle.isPending} onClick={() => lifecycle.mutate('resume')}>
                {t('socialCampaign.resume', 'Resume')}
              </Button>
            ) : c.status === 'DRAFT' ? (
              <Button loading={lifecycle.isPending} onClick={() => lifecycle.mutate('activate')}>
                {t('socialCampaign.activate', 'Activate')}
              </Button>
            ) : null}
          </div>
        }
      />
      <Tabs defaultValue="calendar">
        <TabsList>
          <TabsTrigger value="calendar">{t('socialCampaign.tabCalendar', 'Calendar')}</TabsTrigger>
          <TabsTrigger value="queue">{t('socialCampaign.tabQueue', 'Approval queue')}</TabsTrigger>
        </TabsList>
        <TabsContent value="calendar">
          <SocialCampaignCalendar items={items} />
        </TabsContent>
        <TabsContent value="queue">
          <ApprovalQueue
            items={items}
            pendingId={review.isPending ? review.variables?.itemId : null}
            onReview={(itemId, action) => review.mutate({ itemId, action })}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
