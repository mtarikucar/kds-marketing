/**
 * membershipApi.ts — thin client for the multi-workspace membership surface.
 *
 * Deliberately separate from marketingAuthStore.ts's own imports: the store's
 * `switchWorkspace` action pulls this module in via a dynamic `import()` at
 * call time (not a static top-level import) to avoid a circular-import cycle
 * — this file imports `marketingApi`, which itself imports the auth store.
 */
import marketingApi from './marketingApi';
import type { MarketingUser } from '../../../store/marketingAuthStore';

export interface MembershipSummary {
  workspaceId: string;
  workspaceName: string;
  role: string;
}

/** POST /auth/switch-workspace — mints a fresh token pair scoped to the
 *  target workspace. Response mirrors login's shape (`{ user, accessToken,
 *  refreshToken }`) but never includes `memberships` — callers that need an
 *  up-to-date membership list must follow up with {@link fetchMemberships}. */
export function switchWorkspaceApi(workspaceId: string) {
  return marketingApi
    .post('/auth/switch-workspace', { workspaceId })
    .then((r) => r.data as { user: MarketingUser; accessToken: string; refreshToken: string });
}

/** GET /marketing/auth/profile is the single source of truth for the
 *  caller's membership list — neither /auth/login nor /auth/switch-workspace
 *  return `memberships` on their response, only /auth/profile does. */
export function fetchMemberships(): Promise<MembershipSummary[]> {
  return marketingApi.get('/auth/profile').then((r) => r.data.memberships ?? []);
}

export interface CreateWorkspaceDto {
  workspaceName: string;
  productName?: string;
  productUrl?: string;
  productDescription?: string;
  language?: string;
  currency?: string;
}

export interface CreateWorkspaceResult {
  user: MarketingUser;
  accessToken: string;
  refreshToken: string;
  workspace: { id: string; name: string; slug: string };
}

/** POST /marketing/workspaces — authenticated (any role, any current
 *  workspace). Spins up a brand-new STANDALONE workspace with the caller as
 *  its OWNER via a fresh ACTIVE membership, using the caller's EXISTING
 *  identity (no new password/email). The response is an AUTO-SWITCH
 *  session already scoped to the new workspace — same `{ user, accessToken,
 *  refreshToken }` shape as {@link switchWorkspaceApi}, plus the created
 *  `workspace` summary so the caller can toast/display it. This is the
 *  self-serve "second brand" flow — see MarketingHeader's "New workspace"
 *  profile-menu action. */
export function createWorkspaceApi(dto: CreateWorkspaceDto): Promise<CreateWorkspaceResult> {
  return marketingApi.post('/workspaces', dto).then((r) => r.data as CreateWorkspaceResult);
}

export interface InviteMemberDto {
  email: string;
  role: string;
  customRoleId?: string;
}

export interface InviteMemberResult {
  membershipId: string;
  status: 'INVITED';
  inviteToken?: string;
}

/** POST /marketing/users/invite — requires `users.manage` (OWNER-level).
 *  Creates an INVITED membership (+ a pending identity for a brand-new
 *  email). This is the FE's "Invite member" action — see
 *  pages/marketing/users/InviteUserDialog.tsx. */
export function inviteMember(dto: InviteMemberDto): Promise<InviteMemberResult> {
  return marketingApi.post('/users/invite', dto).then((r) => r.data);
}

export interface AcceptInviteDto {
  token: string;
  /** Required only when the invite is for a brand-new identity — the
   *  backend decides (a pending identity's password is an unusable
   *  sentinel, never a real bcrypt hash) and 400s with "Password required
   *  to accept" when it's needed but missing. */
  password?: string;
}

export interface AcceptInviteResult {
  status: 'ACTIVE';
  workspaceId: string;
}

/** POST /marketing/auth/accept-invite — PUBLIC, no auth header. The invite
 *  token itself is the caller's only credential (see NO_REFRESH_PATHS in
 *  marketingApi.ts, which already exempts this path from the 401-refresh
 *  retry). Flips the INVITED membership to ACTIVE. */
export function acceptInvite(dto: AcceptInviteDto): Promise<AcceptInviteResult> {
  return marketingApi.post('/auth/accept-invite', dto).then((r) => r.data);
}
