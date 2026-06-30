import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { type SocialCampaignItem } from '../../../features/marketing/api/socialCampaigns.service';

export interface ApprovalQueueProps {
  items: SocialCampaignItem[];
  onReview: (itemId: string, action: 'approve' | 'reject' | 'regenerate') => void;
  pendingId?: string | null;
}

export function ApprovalQueue({ items, onReview, pendingId }: ApprovalQueueProps) {
  const { t } = useTranslation('marketing');
  const queue = items.filter((it) => it.status === 'NEEDS_APPROVAL');

  if (queue.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="h-6 w-6" />}
        title={t('socialCampaign.queueEmpty', 'Nothing waiting for approval')}
      />
    );
  }

  return (
    <div className="space-y-3">
      {queue.map((it) => (
        <Card key={it.id}>
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <span className="truncate text-sm">
              {it.topic ?? t('socialCampaign.untitled', 'Untitled post')}
            </span>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" loading={pendingId === it.id} onClick={() => onReview(it.id, 'approve')}>
                {t('socialCampaign.approve', 'Approve')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => onReview(it.id, 'regenerate')}>
                {t('socialCampaign.regenerate', 'Regenerate')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onReview(it.id, 'reject')}>
                {t('socialCampaign.reject', 'Reject')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
