/**
 * mcpOAuth.service.ts — the consent half of the MCP OAuth 2.1 authorization
 * server (Faz 3).
 *
 * Unlike every other file in this folder these endpoints do NOT sit under
 * `/marketing`: the authorization server lives at `/api/mcp-oauth/...` (see
 * `backend/src/modules/mcp-oauth/mcp-oauth-authorize.controller.ts`). They are
 * still called through `marketingApi` on purpose — an absolute `url` makes
 * axios ignore `baseURL` while KEEPING the instance's interceptors, which is
 * what attaches the marketing JWT and transparently refreshes it. The consent
 * routes are `MarketingGuard`-protected, so losing that would 401 the page.
 *
 * The authorize parameters are passed through verbatim in both directions. The
 * page never re-derives them: the backend re-validates the whole request on
 * every call (there is no server-side "pending authorization" to point at), so
 * anything we dropped or rewrote here would simply be rejected.
 */

import { API_URL } from '../../../lib/env';
import marketingApi from './marketingApi';

const CONSENT_URL = `${API_URL}/mcp-oauth/authorize/consent`;

/** One workspace the signed-in user could consent FOR. */
export interface McpConsentWorkspace {
  workspaceId: string;
  workspaceName: string;
  role: string;
  /**
   * The requested scopes this user can actually grant in THIS workspace,
   * already capped by their role server-side. A requested scope missing from
   * this list is one they do not hold — the screen shows it as unavailable
   * rather than silently granting less than the client asked for.
   */
  grantableScopes: string[];
}

export interface McpConsentData {
  client: { clientId: string; clientName: string | null; logoUri: string | null };
  requestedScopes: string[];
  resource: string;
  redirectUri: string;
  state: string | null;
  workspaces: McpConsentWorkspace[];
}

/** The raw authorize query string, forwarded exactly as the client sent it. */
export type McpAuthorizeParams = Record<string, string>;

export const getMcpConsentData = (params: McpAuthorizeParams): Promise<McpConsentData> =>
  marketingApi.get(CONSENT_URL, { params }).then((r) => r.data);

export const submitMcpConsent = (
  params: McpAuthorizeParams,
  body: { workspace_id: string; granted_scopes: string[] },
): Promise<{ redirect_to: string }> =>
  marketingApi.post(CONSENT_URL, { ...params, ...body }).then((r) => r.data);
