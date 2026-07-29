import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthInfo, OAuthError, OAuthErrorCode, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { ApiKeysService } from '../services/api-keys.service';
import { McpOAuthTokenService } from '../../mcp-oauth/mcp-oauth-token.service';
import { isCanonicalMcpResource } from '../../mcp-oauth/mcp-oauth.config';
import { MCP_ALL_SCOPES, expandScopes } from './mcp-scopes';

/** API keys do not expire; the SDK still requires an expiry, so we roll one. */
const SYNTHETIC_TTL_SECONDS = 60 * 60;

/** The prefix Faz 1's programmatic API keys carry (see ApiKeysService.create). */
const API_KEY_PREFIX = 'mk_live_';

const MCP_SCOPE_VOCABULARY: ReadonlySet<string> = new Set(MCP_ALL_SCOPES);

/**
 * Turns an `Authorization: Bearer …` header into an MCP `AuthInfo`. This is the
 * ONLY place a raw token becomes an identity on the MCP surface — and the only
 * seam where Faz 3's OAuth path joins Faz 1's API-key path.
 *
 * The two are told apart by the `mk_live_` prefix, which `ApiKeysService` mints
 * and `authenticate()` already requires. Anything else is an OAuth access
 * token (they carry an `mcp_at_` prefix of their own, precisely so the two
 * namespaces can never collide).
 *
 * Both paths hit the database on every request, so revocation takes effect on
 * the very next call; on the API-key path the synthetic `expiresAt` is a
 * protocol formality, not a cache.
 *
 * What differs between them is the principal. An API key belongs to a
 * WORKSPACE and has no user — that is the gap Faz 3 exists to close. An OAuth
 * token additionally carries `userId`, the human who consented, which is what
 * row-level visibility needs (Task 8).
 */
@Injectable()
export class McpTokenVerifierService implements OAuthTokenVerifier {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly oauth: McpOAuthTokenService,
    private readonly config: ConfigService,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    return token.startsWith(API_KEY_PREFIX)
      ? this.verifyApiKey(token)
      : this.verifyOAuthToken(token);
  }

  /** Faz 1, unchanged: a static workspace credential with no user principal. */
  private async verifyApiKey(token: string): Promise<AuthInfo> {
    const auth = await this.apiKeys.authenticate(token);
    if (!auth) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid or revoked API key');
    }
    return {
      token,
      clientId: auth.apiKeyId,
      scopes: expandScopes(auth.scopes ?? []),
      expiresAt: Math.floor(Date.now() / 1000) + SYNTHETIC_TTL_SECONDS,
      extra: { workspaceId: auth.workspaceId, apiKeyId: auth.apiKeyId },
    };
  }

  private async verifyOAuthToken(token: string): Promise<AuthInfo> {
    const grant = await this.oauth.verifyAccessToken(token);
    // One null for unknown / expired / revoked: which of the three it was is
    // information the presenter has no business learning.
    if (!grant) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid, expired or revoked access token');
    }

    // RFC 8707 audience check. A token is minted for ONE resource server; if
    // this one is not it, the token is being replayed at the wrong door —
    // possibly by a malicious MCP server the user also connected to. Note this
    // fails CLOSED when PUBLIC_BASE_URL is unset: with no canonical resource
    // configured there is nothing to compare against.
    if (!this.audienceIsOurs(grant.resource)) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        'Access token was not issued for this MCP resource',
      );
    }

    // A token authorising nothing on this surface is a valid credential that
    // cannot do anything here — 403/insufficient_scope, not 401, so the client
    // steps up its scopes instead of pointlessly re-authenticating. Per-tool
    // scope enforcement stays where it already lives, in the broker.
    const scopes = (grant.scopes ?? []).filter((s) => MCP_SCOPE_VOCABULARY.has(s));
    if (scopes.length === 0) {
      throw new OAuthError(
        OAuthErrorCode.InsufficientScope,
        'Access token carries no scope valid on the MCP surface',
      );
    }

    return {
      token,
      // The CIMD client URL — the connector's identity, and what audit trails
      // and the Faz 4 "connected clients" view key off.
      clientId: grant.clientId,
      scopes,
      expiresAt: Math.floor(grant.expiresAt.getTime() / 1000),
      resource: new URL(grant.resource),
      extra: {
        workspaceId: grant.workspaceId,
        // The real consenting user. Faz 1's API-key path has no equivalent.
        userId: grant.userId,
        oauthTokenId: grant.tokenId,
      },
    };
  }

  private audienceIsOurs(resource: string): boolean {
    try {
      return isCanonicalMcpResource(resource, this.config.get<string>('PUBLIC_BASE_URL'));
    } catch {
      // mcpOAuthIssuer throws when PUBLIC_BASE_URL is missing.
      return false;
    }
  }
}
