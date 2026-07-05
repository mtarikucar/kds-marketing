import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, Card, Skeleton } from '@/components/ui';

interface ConversationRow {
  id: string;
  status: string;
  aiPaused: boolean;
  unreadCount: number;
  lastMessageAt?: string | null;
  lead?: { businessName?: string; contactPerson?: string } | null;
  channel?: { type?: string; name?: string } | null;
  lastMessage?: { body?: string; direction?: string } | null;
}

interface ConversationListProps {
  conversations: ConversationRow[] | undefined;
  isLoading: boolean;
  isError: boolean;
  selectedId: string | null;
  statusFilter: string;
  isManager: boolean;
  onSelect: (id: string) => void;
  onStatusFilter: (status: string) => void;
  onRetry: () => void;
}

/**
 * Left pane — filterable conversation list.
 * Hidden on mobile when a conversation is open (parent manages visibility class).
 */
export function ConversationList({
  conversations,
  isLoading,
  isError,
  selectedId,
  statusFilter,
  isManager,
  onSelect,
  onStatusFilter,
  onRetry,
}: ConversationListProps) {
  const { t } = useTranslation('marketing');

  return (
    <Card className="w-full sm:w-72 sm:shrink-0 flex flex-col overflow-hidden border border-border">
      {/* Status filter tabs */}
      <div className="p-3 border-b border-border flex gap-1">
        {(['OPEN', 'CLOSED'] as const).map((s) => (
          <button
            key={s}
            onClick={() => onStatusFilter(s)}
            className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
              statusFilter === s
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-surface-muted'
            }`}
          >
            {s === 'OPEN' ? t('inbox.open', 'Open') : t('inbox.closed', 'Closed')}
          </button>
        ))}
      </div>

      {/* List body */}
      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {isLoading && (
          <div className="p-3 space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        )}

        {isError && !isLoading && (
          <div className="p-3">
            <div className="bg-danger-subtle border border-danger/20 rounded-lg p-4 text-center">
              <p className="text-sm text-danger">
                {t('inbox.loadFailed', 'Could not load conversations.')}
              </p>
              <button
                onClick={onRetry}
                className="mt-3 px-3 py-1.5 text-sm font-medium text-danger bg-surface border border-danger/30 rounded-lg hover:bg-danger-subtle"
              >
                {t('common.retry', 'Retry')}
              </button>
            </div>
          </div>
        )}

        {!isLoading &&
          !isError &&
          (conversations ?? []).map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={`w-full text-left p-3 hover:bg-surface-muted transition-colors ${
                selectedId === c.id ? 'bg-primary/5' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-sm text-foreground truncate">
                  {c.lead?.contactPerson ||
                    c.lead?.businessName ||
                    t('inbox.unknown', 'Unknown')}
                </span>
                {c.unreadCount > 0 && (
                  <Badge tone="primary" size="sm">
                    {c.unreadCount}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] uppercase text-muted-foreground">
                  {c.channel?.type}
                </span>
                {c.aiPaused && (
                  <span className="text-[10px] text-warning">
                    {t('inbox.aiOff', 'AI off')}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {c.lastMessage?.body ?? ''}
              </p>
            </button>
          ))}

        {!isLoading && !isError && (conversations ?? []).length === 0 && (
          <div className="p-3">
            <EmptyState
              title={t('inbox.empty', 'No conversations yet.')}
              description={t('inbox.emptyHint')}
              action={
                isManager ? (
                  <Link
                    to="/inbox?tab=channels"
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {t('inbox.connectChannel')}
                  </Link>
                ) : undefined
              }
            />
          </div>
        )}
      </div>
    </Card>
  );
}
