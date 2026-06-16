import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { fmtDateTime } from '../../../../features/marketing/utils/format';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import type { WebhookEndpoint } from './WebhookFormDialog';

interface WebhookDelivery {
  id: string;
  eventType: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  responseCode?: number | null;
  attempts: number;
  error?: string | null;
  createdAt: string;
  deliveredAt?: string | null;
}

type DeliveryTone = 'neutral' | 'success' | 'danger';

const STATUS_TONE: Record<string, DeliveryTone> = {
  PENDING: 'neutral',
  SUCCESS: 'success',
  FAILED: 'danger',
};

interface WebhookDeliveriesDialogProps {
  endpoint: WebhookEndpoint | null;
  onOpenChange: (open: boolean) => void;
}

export function WebhookDeliveriesDialog({
  endpoint,
  onOpenChange,
}: WebhookDeliveriesDialogProps) {
  const { t } = useTranslation('marketing');

  const { data, isLoading } = useQuery<WebhookDelivery[]>({
    queryKey: ['marketing', 'webhooks', endpoint?.id, 'deliveries'],
    queryFn: () =>
      marketingApi.get(`/webhooks/${endpoint!.id}/deliveries`).then((r) => r.data),
    enabled: !!endpoint,
  });

  const deliveries: WebhookDelivery[] = Array.isArray(data) ? data : [];

  return (
    <Dialog open={!!endpoint} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('webhooks.deliveries.title', { defaultValue: 'Recent deliveries' })}
          </DialogTitle>
          <DialogDescription className="truncate">
            {endpoint?.url}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : deliveries.length === 0 ? (
          <EmptyState
            icon={<Send className="h-10 w-10" />}
            title={t('webhooks.deliveries.empty', { defaultValue: 'No deliveries yet' })}
            description={t('webhooks.deliveries.emptyHint', {
              defaultValue: 'Send a test event or wait for a subscribed event to fire.',
            })}
          />
        ) : (
          <div className="max-h-[60vh] divide-y divide-border overflow-y-auto">
            {deliveries.map((d) => (
              <div key={d.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONE[d.status] ?? 'neutral'} size="sm">
                      {t(`webhooks.deliveryStatus.${d.status}`, { defaultValue: d.status })}
                    </Badge>
                    <code className="truncate font-mono text-xs text-foreground">
                      {d.eventType}
                    </code>
                  </div>
                  {d.error && (
                    <p className="mt-1 truncate text-xs text-danger" title={d.error}>
                      {d.error}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <p>
                    {d.responseCode != null
                      ? `HTTP ${d.responseCode}`
                      : t('webhooks.deliveries.noResponse', { defaultValue: 'no response' })}
                    {' · '}
                    {t('webhooks.deliveries.attempts', {
                      defaultValue: '{{count}} attempt(s)',
                      count: d.attempts,
                    })}
                  </p>
                  <p>{fmtDateTime(d.deliveredAt ?? d.createdAt)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
