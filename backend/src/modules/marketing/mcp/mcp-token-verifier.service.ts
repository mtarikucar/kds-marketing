import { Injectable } from '@nestjs/common';
import { AuthInfo, OAuthError, OAuthErrorCode, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { ApiKeysService } from '../services/api-keys.service';
import { expandScopes } from './mcp-scopes';

/** API keys do not expire; the SDK still requires an expiry, so we roll one. */
const SYNTHETIC_TTL_SECONDS = 60 * 60;

/**
 * Turns an `Authorization: Bearer mk_live_…` header into an MCP `AuthInfo`.
 * This is the ONLY place a raw token becomes an identity on the MCP surface.
 * Revocation is enforced on every request because `authenticate()` hits the
 * database each time — the synthetic `expiresAt` is a protocol formality, not
 * a cache.
 */
@Injectable()
export class McpTokenVerifierService implements OAuthTokenVerifier {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
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
}
