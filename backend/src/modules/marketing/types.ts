/** Workspace-scoped roles. OWNER ⊃ MANAGER ⊃ REP (hierarchical — see
 * MarketingRolesGuard). SYSTEM is the per-workspace research sentinel:
 * rows are attributed to it, but it can never authenticate or pass a guard. */
export type MarketingRole = 'OWNER' | 'MANAGER' | 'REP' | 'SYSTEM';

export interface MarketingJwtPayload {
  sub: string;
  email: string;
  role: string;
  /** Workspace claim — the guard cross-checks it against the user row so a
   * token can never outlive a user's workspace membership. */
  wsp: string;
  type: 'marketing';
}

export interface MarketingUserPayload {
  id: string;
  workspaceId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  /** Epic F — when set, the custom role's granular permission set overrides the
   * legacy OWNER/MANAGER/REP mapping (resolved by PermissionsGuard). */
  customRoleId?: string | null;
  /** NetGSM Phase 3 Task 3 — the rep's webphone extension (MarketingUser.dahili),
   * the routing key for the telephony screen-pop SSE stream. Only populated by
   * guards that select it (currently SseTokenGuard); undefined elsewhere. */
  dahili?: string | null;
}

/** A user's ACTIVE membership as surfaced to the FE switcher / profile. */
export interface MembershipSummary {
  workspaceId: string;
  workspaceName: string;
  role: string;
}

/** Epic D1 — position of a workspace in the agency / sub-account hierarchy.
 *  STANDALONE: plain single tenant (default). AGENCY: owns LOCATION children.
 *  LOCATION: a sub-account whose `parentWorkspaceId` points at its AGENCY.
 *  Stored as a String column on Workspace (status-string convention). */
export type WorkspaceKind = 'STANDALONE' | 'AGENCY' | 'LOCATION';

export const WORKSPACE_KINDS: readonly WorkspaceKind[] = [
  'STANDALONE',
  'AGENCY',
  'LOCATION',
] as const;
