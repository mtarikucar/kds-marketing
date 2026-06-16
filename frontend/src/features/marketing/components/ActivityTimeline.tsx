import {
  Phone,
  MapPin,
  Mail,
  MessageCircle,
  RefreshCw,
  LineChart,
  Users,
  UserPlus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LeadActivity, LeadActivityAssignmentMetadata } from '../types';
import { fmtDate } from '../utils/format';

const activityIcons: Record<string, React.ElementType> = {
  CALL: Phone,
  VISIT: MapPin,
  EMAIL: Mail,
  WHATSAPP: MessageCircle,
  NOTE: MessageCircle,
  STATUS_CHANGE: RefreshCw,
  DEMO: LineChart,
  MEETING: Users,
};

const outcomeColors: Record<string, string> = {
  POSITIVE: 'text-green-600 dark:text-green-400',
  NEGATIVE: 'text-red-600 dark:text-red-400',
  NEUTRAL: 'text-muted-foreground',
  NO_ANSWER: 'text-orange-600 dark:text-orange-400',
};

interface ActivityTimelineProps {
  activities: LeadActivity[];
}

// Type guard for the assignment metadata shape we set on the backend.
function isAssignmentMeta(
  meta: LeadActivity['metadata'],
): meta is LeadActivityAssignmentMetadata {
  return Boolean(meta && typeof meta === 'object' && (meta as any).kind === 'assignment');
}

export default function ActivityTimeline({ activities }: ActivityTimelineProps) {
  const { t } = useTranslation('marketing');

  if (!activities.length) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No activities yet
      </p>
    );
  }

  return (
    <div className="flow-root">
      <ul className="-mb-8">
        {activities.map((activity, idx) => {
          const assignmentMeta = isAssignmentMeta(activity.metadata)
            ? activity.metadata
            : null;
          // Assignment events get their own icon so they stand out from
          // generic STATUS_CHANGE rows in a busy timeline.
          const Icon = assignmentMeta
            ? UserPlus
            : activityIcons[activity.type] || MessageCircle;
          const isLast = idx === activities.length - 1;

          return (
            <li key={activity.id}>
              <div className="relative pb-8">
                {!isLast && (
                  <span className="absolute left-4 top-4 -ml-px h-full w-0.5 bg-border" />
                )}
                <div className="relative flex space-x-3">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full ${
                      assignmentMeta ? 'bg-primary/10' : 'bg-muted'
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 ${
                        assignmentMeta ? 'text-primary' : 'text-muted-foreground'
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-foreground truncate">
                        {assignmentMeta
                          ? renderAssignmentTitle(assignmentMeta, t)
                          : activity.title}
                      </p>
                      <time className="text-xs text-muted-foreground shrink-0">
                        {fmtDate(activity.createdAt)}
                      </time>
                    </div>
                    {activity.description && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {activity.description}
                      </p>
                    )}
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                      <span>
                        {activity.createdBy.firstName} {activity.createdBy.lastName}
                      </span>
                      {assignmentMeta?.auto && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                          {t('activityTimeline.assignmentAuto')}
                        </span>
                      )}
                      {assignmentMeta?.bulk && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                          {t('activityTimeline.assignmentBulk')}
                        </span>
                      )}
                      {activity.outcome && (
                        <span className={outcomeColors[activity.outcome] || 'text-muted-foreground'}>
                          {activity.outcome}
                        </span>
                      )}
                      {activity.duration && (
                        <span>{activity.duration} min</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function renderAssignmentTitle(
  meta: LeadActivityAssignmentMetadata,
  t: (key: string) => string,
): string {
  // Unassign — toUserId is null and there was a previous owner.
  if (!meta.toUserId) {
    return meta.fromUserName
      ? `${t('activityTimeline.assignmentUnassigned')}: ${meta.fromUserName}`
      : t('activityTimeline.assignmentUnassigned');
  }
  // Initial assignment — no previous owner.
  if (!meta.fromUserId) {
    return meta.toUserName ?? 'Assigned';
  }
  // Transfer between two reps.
  return `${meta.fromUserName ?? '?'} → ${meta.toUserName ?? '?'}`;
}
