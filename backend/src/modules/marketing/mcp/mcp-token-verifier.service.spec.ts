import { OAuthErrorCode } from '@modelcontextprotocol/server';
import { McpTokenVerifierService } from './mcp-token-verifier.service';

const BASE = 'https://jeeta.example.com';
const RESOURCE = `${BASE}/api/mcp`;

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    tokenId: 'tok-1',
    clientId: 'https://claude.ai/mcp/client-metadata.json',
    workspaceId: 'ws-1',
    userId: 'user-1',
    scopes: ['leads.read'],
    resource: RESOURCE,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  };
}

/** `opts.baseUrl` is only omitted to model an unconfigured deployment. */
function deps(
  auth: unknown,
  oauthGrant: unknown = null,
  opts: { baseUrl?: string } = { baseUrl: BASE },
) {
  const authenticate = jest.fn().mockResolvedValue(auth);
  const apiKeys = { authenticate } as any;
  const verifyAccessToken = jest.fn().mockResolvedValue(oauthGrant);
  const oauth = { verifyAccessToken } as any;
  const config = { get: (k: string) => (k === 'PUBLIC_BASE_URL' ? opts.baseUrl : undefined) } as any;
  return {
    verifier: new McpTokenVerifierService(apiKeys, oauth, config),
    authenticate,
    verifyAccessToken,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  throw new Error('expected the token to be rejected');
}

describe('McpTokenVerifierService', () => {
  /**
   * REGRESSION — Faz 1's API-key path. Claude Code authenticates with a static
   * `mk_live_…` key and must keep working exactly as before OAuth landed.
   */
  describe('mk_live_ — the API-key path (unchanged)', () => {
    it('resolves a valid key to AuthInfo carrying the workspace', async () => {
      const { verifier } = deps({ apiKeyId: 'k1', workspaceId: 'ws1', scopes: ['read'] });
      const info = await verifier.verifyAccessToken('mk_live_abc');
      expect(info.extra).toMatchObject({ workspaceId: 'ws1', apiKeyId: 'k1' });
      expect(info.clientId).toBe('k1');
      expect(info.token).toBe('mk_live_abc');
    });

    it('always populates expiresAt (the SDK rejects tokens without it)', async () => {
      const { verifier } = deps({ apiKeyId: 'k1', workspaceId: 'ws1', scopes: ['read'] });
      const info = await verifier.verifyAccessToken('mk_live_abc');
      expect(typeof info.expiresAt).toBe('number');
      expect(info.expiresAt!).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('expands legacy scopes onto the AuthInfo', async () => {
      const { verifier } = deps({ apiKeyId: 'k1', workspaceId: 'ws1', scopes: ['read'] });
      const info = await verifier.verifyAccessToken('mk_live_abc');
      expect(info.scopes).toContain('reports.read');
    });

    it('throws for an unknown or revoked key', async () => {
      const { verifier } = deps(null);
      await expect(verifier.verifyAccessToken('mk_live_nope')).rejects.toThrow();
    });

    it('never consults the OAuth store for an API key', async () => {
      const { verifier, verifyAccessToken } = deps({
        apiKeyId: 'k1',
        workspaceId: 'ws1',
        scopes: ['read'],
      });
      await verifier.verifyAccessToken('mk_live_abc');
      expect(verifyAccessToken).not.toHaveBeenCalled();
    });

    it('is not subject to the OAuth audience check', async () => {
      // An API key has no `resource` binding at all; routing it through the
      // audience check would break every existing Claude Code session.
      const { verifier } = deps({ apiKeyId: 'k1', workspaceId: 'ws1', scopes: ['read'] }, null, {});
      await expect(verifier.verifyAccessToken('mk_live_abc')).resolves.toBeDefined();
    });
  });

  describe('OAuth access tokens (everything that is not mk_live_)', () => {
    it('resolves to AuthInfo carrying the workspace AND the real user', async () => {
      const { verifier, verifyAccessToken, authenticate } = deps(null, grantRow());
      const info = await verifier.verifyAccessToken('mcp_at_abc');

      expect(authenticate).not.toHaveBeenCalled();
      expect(verifyAccessToken).toHaveBeenCalledWith('mcp_at_abc');
      // `userId` is the point of the OAuth path: unlike an API key, this
      // session has a human principal, which row-level visibility needs.
      expect(info.extra).toMatchObject({ workspaceId: 'ws-1', userId: 'user-1' });
      expect(info.clientId).toBe('https://claude.ai/mcp/client-metadata.json');
      expect(info.scopes).toEqual(['leads.read']);
    });

    it('reports the token’s own expiry, in epoch seconds', async () => {
      const expiresAt = new Date(Date.now() + 1_800_000);
      const { verifier } = deps(null, grantRow({ expiresAt }));
      const info = await verifier.verifyAccessToken('mcp_at_abc');
      expect(info.expiresAt).toBe(Math.floor(expiresAt.getTime() / 1000));
    });

    it('carries the RFC 8707 audience onto the AuthInfo', async () => {
      const { verifier } = deps(null, grantRow());
      const info = await verifier.verifyAccessToken('mcp_at_abc');
      expect(info.resource?.toString()).toBe(RESOURCE);
    });

    it('rejects an unknown, expired or revoked token', async () => {
      // The store returns null for all three — expiry and revocation are
      // re-read from the database on every call, never cached.
      const { verifier } = deps(null, null);
      expect(await codeOf(verifier.verifyAccessToken('mcp_at_gone'))).toBe(
        OAuthErrorCode.InvalidToken,
      );
    });

    it('rejects a token minted for a DIFFERENT audience', async () => {
      const { verifier } = deps(null, grantRow({ resource: 'https://evil.example/api/mcp' }));
      // RFC 8707 — without this check a token a user consented to for someone
      // else's resource server would be replayable against ours.
      expect(await codeOf(verifier.verifyAccessToken('mcp_at_abc'))).toBe(
        OAuthErrorCode.InvalidToken,
      );
    });

    it('rejects a token whose audience merely starts with ours', async () => {
      const { verifier } = deps(null, grantRow({ resource: `${RESOURCE}-evil` }));
      expect(await codeOf(verifier.verifyAccessToken('mcp_at_abc'))).toBe(
        OAuthErrorCode.InvalidToken,
      );
    });

    it('accepts the canonical audience with a trailing slash', async () => {
      const { verifier } = deps(null, grantRow({ resource: `${RESOURCE}/` }));
      await expect(verifier.verifyAccessToken('mcp_at_abc')).resolves.toBeDefined();
    });

    it('refuses a token that carries no usable MCP scope', async () => {
      const { verifier } = deps(null, grantRow({ scopes: [] }));
      // 403 territory, not 401: the credential is valid, it simply authorises
      // nothing here, so the client's recovery is a step-up, not a re-login.
      expect(await codeOf(verifier.verifyAccessToken('mcp_at_abc'))).toBe(
        OAuthErrorCode.InsufficientScope,
      );
    });

    it('refuses a token whose scopes are all outside the MCP vocabulary', async () => {
      const { verifier } = deps(null, grantRow({ scopes: ['billing.manage'] }));
      expect(await codeOf(verifier.verifyAccessToken('mcp_at_abc'))).toBe(
        OAuthErrorCode.InsufficientScope,
      );
    });

    it('rejects every OAuth token when the deployment has no PUBLIC_BASE_URL', async () => {
      const { verifier } = deps(null, grantRow(), {});
      // With no canonical resource configured there is nothing to check the
      // audience against — fail closed rather than accept anything.
      expect(await codeOf(verifier.verifyAccessToken('mcp_at_abc'))).toBe(
        OAuthErrorCode.InvalidToken,
      );
    });
  });
});
