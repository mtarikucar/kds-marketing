import { useTranslation } from 'react-i18next';
import { Badge, type BadgeProps } from '@/components/ui';
import type { ActorKind, ApiKeyStatus, MembershipStatus, WorkspaceStatus } from '@/api/types';

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
