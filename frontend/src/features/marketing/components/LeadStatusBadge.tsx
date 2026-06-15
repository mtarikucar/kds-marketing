import { Badge } from '@/components/ui/Badge';
import type { BadgeProps } from '@/components/ui/Badge';
import { LeadStatus, LEAD_STATUS_LABELS } from '../types';

type Tone = BadgeProps['tone'];

/** Map each LeadStatus to a Console Badge tone (token-based, dark-mode-safe). */
const STATUS_TONE: Record<LeadStatus, Tone> = {
  [LeadStatus.NEW]: 'info',
  [LeadStatus.CONTACTED]: 'primary',
  [LeadStatus.NOT_REACHABLE]: 'warning',
  [LeadStatus.MEETING_DONE]: 'info',
  [LeadStatus.DEMO_SCHEDULED]: 'primary',
  [LeadStatus.OFFER_SENT]: 'warning',
  [LeadStatus.WAITING]: 'neutral',
  [LeadStatus.WON]: 'success',
  [LeadStatus.LOST]: 'danger',
};

interface LeadStatusBadgeProps {
  status: LeadStatus | string;
}

export default function LeadStatusBadge({ status }: LeadStatusBadgeProps) {
  const label = LEAD_STATUS_LABELS[status as LeadStatus] || status;
  const tone: Tone = STATUS_TONE[status as LeadStatus] ?? 'neutral';

  return (
    <Badge tone={tone} size="sm">
      {label}
    </Badge>
  );
}
