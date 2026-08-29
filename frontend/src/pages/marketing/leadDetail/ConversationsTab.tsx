import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { MessagesSquare } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryStateBoundary } from '@/components/ui/QueryStateBoundary';
import {
  listConversations,
  type ConversationSummary,
} from '../../../features/marketing/api/conversations.service';

interface ConversationsTabProps {
  leadId: string;
  fmtDate: (d: string | Date | null | undefined) => string;
}

/**
 * "Konuşmalar" — every thread this lead has, on every channel, on the lead's
 * own record. Until now the only way to read a customer's history was to open
 * the Inbox and hunt for their name, which meant the person and the
 * conversation about the person lived on two separate screens.
 *
 * The list is fetched with `leadId` and nothing else. That filter is the whole
 * correctness of this panel: an unfiltered request returns the workspace's
 * threads and renders a perfectly plausible, completely wrong list — so the
 * spec pins the parameter as well as the rendering.
 */
export default function ConversationsTab({ leadId, fmtDate }: ConversationsTabProps) {
  const { t } = useTranslation('marketing');

  // Keyed under ['marketing','conversations',…] on purpose: the Inbox's SSE
  // stream invalidates that prefix on every event, so a reply that arrives
  // while this tab is open refreshes it too.
  const q = useQuery<ConversationSummary[]>({
    queryKey: ['marketing', 'conversations', 'lead', leadId],
    queryFn: () => listConversations({ leadId }),
  });

  const conversations = q.data ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t('leadDetail.tabs.conversations', 'Konuşmalar')}</CardTitle>
      </CardHeader>
      <CardContent>
        {/* isError, NOT `data?.length === 0` — a thrown fetch and an empty
            inbox are the same blank panel unless the failure gets its own
            branch, and a panel that answers "nothing here" to a question it
            could not ask is worse than one that answers nothing at all. */}
        <QueryStateBoundary
          isLoading={q.isLoading}
          isError={q.isError}
          onRetry={() => q.refetch()}
          errorMessage={t('leadDetail.conversations.failed', 'Konuşmalar yüklenemedi.')}
        >
          {conversations.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare className="h-5 w-5" />}
              title={t('leadDetail.conversations.empty.title', 'Bu kişiyle henüz konuşulmadı')}
              description={t(
                'leadDetail.conversations.empty.desc',
                'WhatsApp, e-posta ya da başka bir kanaldan ilk mesaj geldiğinde burada görürsün.',
              )}
              action={
                <Link to="/inbox" className="text-sm font-medium text-primary hover:underline">
                  {t('leadDetail.conversations.openInbox', 'Gelen kutusunu aç')}
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {conversations.map((c) => (
                <li
                  key={c.id}
                  data-testid={`conversation-${c.id}`}
                  className="flex items-start gap-3 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs font-medium uppercase text-muted-foreground">
                        {c.channel?.type ||
                          t('leadDetail.conversations.unknownChannel', 'Bilinmeyen kanal')}
                      </span>
                      {c.channel?.name && (
                        <span className="truncate text-xs text-muted-foreground">
                          {c.channel.name}
                        </span>
                      )}
                      <Badge tone={c.status === 'OPEN' ? 'info' : 'neutral'} size="sm">
                        {c.status}
                      </Badge>
                      {c.aiPaused && (
                        <Badge tone="warning" size="sm">
                          {t('leadDetail.conversations.aiPaused', 'AI kapalı')}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-foreground">
                      {c.lastMessage?.body || t('leadDetail.conversations.noMessage', 'Mesaj yok')}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-xs text-muted-foreground">{fmtDate(c.lastMessageAt)}</span>
                    {c.unreadCount > 0 && (
                      <Badge tone="primary" size="sm">
                        {c.unreadCount}
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryStateBoundary>
      </CardContent>
    </Card>
  );
}
