import { McpTokenVerifierService } from './mcp-token-verifier.service';

function deps(auth: unknown) {
  const authenticate = jest.fn().mockResolvedValue(auth);
  const apiKeys = { authenticate } as any;
  return { verifier: new McpTokenVerifierService(apiKeys), authenticate };
}

describe('McpTokenVerifierService', () => {
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
});
