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
