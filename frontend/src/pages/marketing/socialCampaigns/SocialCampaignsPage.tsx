import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Plus, CalendarRange } from 'lucide-react';
import {
  listSocialCampaigns,
  type SocialCampaign,
  type SocialCampaignStatus,
} from '../../../features/marketing/api/socialCampaigns.service';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';

const STATUS_TONE: Record<SocialCampaignStatus, BadgeProps['tone']> = {
  ACTIVE: 'success',
  DRAFT: 'neutral',
  PAUSED: 'warning',
  COMPLETED: 'info',
  CANCELLED: 'neutral',
};

export default function SocialCampaignsPage() {
  const { t } = useTranslation('marketing');
  const { data, isLoading, isError, refetch } = useQuery<SocialCampaign[]>({
    queryKey: ['marketing', 'social-campaigns'],
    queryFn: listSocialCampaigns,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('socialCampaign.title', 'Social Campaigns')}
        description={t('socialCampaign.subtitle', 'AI-planned social content calendars')}
        actions={
          <Button asChild>
            <Link to="/social-campaigns/new">
              <Plus className="h-4 w-4" /> {t('socialCampaign.new', 'New campaign')}
            </Link>
          </Button>
        }
      />
      <QueryStateBoundary
        isLoading={isLoading}
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('common.loadError', 'Could not load. Please try again.')}
      >
        {!data || data.length === 0 ? (
          <EmptyState
            icon={<CalendarRange className="h-6 w-6" />}
            title={t('socialCampaign.emptyTitle', 'No social campaigns yet')}
            description={t(
              'socialCampaign.emptyBody',
              'Create a campaign to let AI plan and publish your social content.',
            )}
          />
        ) : (
          <div className="grid gap-3">
            {data.map((sc) => (
              <Card key={sc.id}>
                <CardContent className="flex items-center justify-between p-4">
                  <Link to={`/social-campaigns/${sc.id}`} className="font-medium hover:underline">
                    {sc.name}
                  </Link>
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{sc.automationMode}</Badge>
                    <Badge tone={STATUS_TONE[sc.status]}>{sc.status}</Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </QueryStateBoundary>
    </div>
  );
}
