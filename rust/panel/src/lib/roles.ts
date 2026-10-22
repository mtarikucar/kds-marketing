import type { TFunction } from 'i18next';
import { SYSTEM_ROLE_KEYS, type MembershipView, type MeOut, type Permission, type SystemRoleKey } from '@/api/types';

export function isSystemRoleKey(key: string): key is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(key);
}

/** A role as shown: system roles by their translated name, custom roles by their own name. */
export function roleLabel(t: TFunction, key: string, name?: string | null): string {
  if (isSystemRoleKey(key)) return t(`roleNames.${key}`);
  return name || key;
}

/** The membership of the session's current workspace, if any. */
export function currentMembership(me: MeOut | undefined): MembershipView | undefined {
  if (!me?.current_workspace) return undefined;
  return me.memberships.find((m) => m.workspace_id === me.current_workspace);
}

/** Whether the current membership grants `permission` (the server checks again). */
export function can(me: MeOut | undefined, permission: Permission): boolean {
  return currentMembership(me)?.permissions.includes(permission) ?? false;
}

/** Whether the current membership's role is `owner` or `manager` (the server checks again). */
export function isOwnerOrManager(me: MeOut | undefined): boolean {
  const role = currentMembership(me)?.role_key;
  return role === 'owner' || role === 'manager';
}

/**
 * Whether the user may approve or archive the strategy: the role `owner` or `manager`, and
 * `team.manage` as well, as `strategy.approve` asks (the server checks again).
 */
export function canApproveStrategy(me: MeOut | undefined): boolean {
  return isOwnerOrManager(me) && can(me, 'team.manage');
}
