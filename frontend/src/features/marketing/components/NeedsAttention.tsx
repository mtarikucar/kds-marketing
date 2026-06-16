import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Clock, Inbox, MessageSquare, ClipboardList, FileText } from 'lucide-react';
import { cn } from '@/components/ui';

interface Stats {
  pendingTasks?: number;
  activeOffers?: number;
  unassignedLeads?: number;
}
interface Today {
  overdueTasks?: number;
}
interface Props {
  stats?: Stats;
  today?: Today;
  isManager: boolean;
  conversationAiEnabled: boolean;
  unreadCount?: number;
}

type Tone = 'red' | 'yellow' | 'primary';
const toneCls: Record<Tone, string> = {
  red: 'border-danger/30 bg-danger-subtle text-danger',
  yellow: 'border-warning/30 bg-warning-subtle text-warning',
  primary: 'border-primary/20 bg-primary/5 text-primary',
};

/**
 * Turns the dashboard's otherwise-dead counts into actionable deep-links —
 * "what's waiting on you right now." Pure presentational: it takes the counts
 * the dashboard already fetches, drops anything at zero, and renders nothing
 * when there's no outstanding work (so a clean workspace shows no noise). The
 * counts arrive already role-scoped from the backend, so a REP naturally sees
 * their own pipeline (their "your day" view).
 */
export default function NeedsAttention({
  stats,
  today,
  isManager,
  conversationAiEnabled,
  unreadCount = 0,
}: Props) {
  const { t } = useTranslation('marketing');

  const overdue = today?.overdueTasks ?? 0;
  const unassigned = stats?.unassignedLeads ?? 0;
  const pending = stats?.pendingTasks ?? 0;
  const offers = stats?.activeOffers ?? 0;

  const items: {
    id: string;
    count: number;
    to: string;
    label: string;
    tone: Tone;
    icon: ReactNode;
  }[] = [];

  if (overdue > 0)
    items.push({
      id: 'overdue',
      count: overdue,
      to: '/tasks?tab=overdue',
      label: t('needsAttention.overdueTasks'),
      tone: 'red',
      icon: <Clock className="w-5 h-5" />,
    });
  if (isManager && unassigned > 0)
    items.push({
      id: 'unassigned',
      count: unassigned,
      to: '/leads?assignmentStatus=unassigned',
      label: t('needsAttention.unassignedLeads'),
      tone: unassigned > 10 ? 'red' : 'yellow',
      icon: <Inbox className="w-5 h-5" />,
    });
  if (conversationAiEnabled && unreadCount > 0)
    items.push({
      id: 'unread',
      count: unreadCount,
      to: '/inbox',
      label: t('needsAttention.unread'),
      tone: 'primary',
      icon: <MessageSquare className="w-5 h-5" />,
    });
  if (pending > 0)
    items.push({
      id: 'pending',
      count: pending,
      to: '/tasks',
      label: t('needsAttention.pendingTasks'),
      tone: 'yellow',
      icon: <ClipboardList className="w-5 h-5" />,
    });
  if (offers > 0)
    items.push({
      id: 'offers',
      count: offers,
      to: '/offers?status=SENT',
      label: t('needsAttention.openOffers'),
      tone: 'primary',
      icon: <FileText className="w-5 h-5" />,
    });

  if (items.length === 0) return null;

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-display text-h3 text-foreground">
          {t('needsAttention.title')}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {t('needsAttention.subtitle')}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {items.map((it) => (
          <Link
            key={it.id}
            to={it.to}
            className={cn(
              'flex items-center gap-3 p-4 rounded-xl border transition-opacity hover:opacity-90',
              toneCls[it.tone],
            )}
          >
            <span className="shrink-0">{it.icon}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-2xl font-bold leading-none">{it.count}</span>
              <span className="block text-sm mt-1 truncate">{it.label}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
