import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui';
import type {
  ActorKind,
  ApiKeyStatus,
  ConsultationKind,
  EffectiveStatus,
  HypothesisState,
  MembershipStatus,
  VersionStatus,
  WorkspaceStatus,
} from '@/api/types';

type Tone = NonNullable<BadgeProps['tone']>;

const WORKSPACE_TONE: Record<WorkspaceStatus, Tone> = {
  pending_payment: 'warning',
  active: 'success',
  suspended: 'danger',
};

const MEMBER_TONE: Record<MembershipStatus, Tone> = {
  invited: 'info',
  active: 'success',
  removed: 'neutral',
};

const KEY_TONE: Record<ApiKeyStatus, Tone> = {
  active: 'success',
  revoked: 'neutral',
};

const ACTOR_TONE: Record<ActorKind, Tone> = {
  human: 'primary',
  agent: 'info',
  system: 'neutral',
};

const CAPABILITY_TONE: Record<EffectiveStatus, Tone> = {
  declared: 'info',
  verified: 'success',
  stale: 'warning',
  unreachable: 'danger',
  retired: 'neutral',
};

const VERSION_TONE: Record<VersionStatus, Tone> = {
  draft: 'info',
  approved: 'success',
  archived: 'neutral',
};

const HYPOTHESIS_TONE: Record<HypothesisState, Tone> = {
  kept: 'success',
  retired: 'neutral',
  added: 'primary',
};

const CONSULTATION_TONE: Record<ConsultationKind, Tone> = {
  question: 'info',
  answer: 'success',
  assumption: 'warning',
  section_draft: 'primary',
  note: 'neutral',
  submitted: 'primary',
  approved: 'success',
  archived: 'neutral',
};

export function WorkspaceStatusBadge({ status }: { status: WorkspaceStatus }) {
  const { t } = useTranslation();
  return (
    <Badge tone={WORKSPACE_TONE[status]} data-status={status}>
      {t(`status.workspace.${status}`)}
    </Badge>
  );
}

export function MemberStatusBadge({ status }: { status: MembershipStatus }) {
  const { t } = useTranslation();
  return <Badge tone={MEMBER_TONE[status]}>{t(`status.member.${status}`)}</Badge>;
}

export function KeyStatusBadge({ status }: { status: ApiKeyStatus }) {
  const { t } = useTranslation();
  return <Badge tone={KEY_TONE[status]}>{t(`status.key.${status}`)}</Badge>;
}

export function ActorBadge({ kind }: { kind: ActorKind }) {
  const { t } = useTranslation();
  return (
    <Badge tone={ACTOR_TONE[kind]} size="sm">
      {t(`actor.${kind}`)}
    </Badge>
  );
}

/** A capability's effective status: one of the five, `stale` once a verification lapsed. */
export function CapabilityStatusBadge({ status }: { status: EffectiveStatus }) {
  const { t } = useTranslation();
  return (
    <Badge tone={CAPABILITY_TONE[status]} data-capability-status={status}>
      {t(`status.capability.${status}`)}
    </Badge>
  );
}

export function VersionStatusBadge({ status }: { status: VersionStatus }) {
  const { t } = useTranslation();
  return (
    <Badge tone={VERSION_TONE[status]} size="sm">
      {t(`status.version.${status}`)}
    </Badge>
  );
}

export function HypothesisStateBadge({ state }: { state: HypothesisState }) {
  const { t } = useTranslation();
  return (
    <Badge tone={HYPOTHESIS_TONE[state]} size="sm">
      {t(`strategy.hypotheses.states.${state}`)}
    </Badge>
  );
}

export function ConsultationKindBadge({ kind }: { kind: ConsultationKind }) {
  const { t } = useTranslation();
  return (
    <Badge tone={CONSULTATION_TONE[kind]} size="sm">
      {t(`strategy.consultation.kinds.${kind}`)}
    </Badge>
  );
}
