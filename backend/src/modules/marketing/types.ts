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
