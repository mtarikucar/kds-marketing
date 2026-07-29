import { mockDeep } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';
import { McpOAuthTokenService } from './mcp-oauth-token.service';
import { OAuthHttpException } from './mcp-oauth.errors';
import { sha256Hex } from './mcp-oauth.crypto';
import { PrismaService } from '../../prisma/prisma.service';

const BASE = 'https://jeeta.example.com';
const RESOURCE = `${BASE}/api/mcp`;
const CLIENT_ID = 'https://claude.ai/mcp/client-metadata.json';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

/**
 * The verifier/challenge pair from RFC 7636 Appendix B, verbatim. Hard-coded
 * rather than computed with our own helper so the test proves we implement the
 * RFC, not merely that we agree with ourselves.
 */
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'code-1',
    codeHash: 'irrelevant',
    clientId: CLIENT_ID,
    workspaceId: 'ws-1',
    userId: 'user-1',
    redirectUri: REDIRECT,
    scopes: ['leads.read', 'leads.write'],
    resource: RESOURCE,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function refreshRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rt-1',
    tokenHash: 'irrelevant',
    type: 'REFRESH',
    clientId: CLIENT_ID,
    workspaceId: 'ws-1',
    userId: 'user-1',
    scopes: ['leads.read'],
    resource: RESOURCE,
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    parentId: 'code-1',
    createdAt: new Date(),
    ...overrides,
  };
}

function make() {
  const prisma = mockDeep<PrismaClient>();
  (prisma.mcpOAuthCode.findUnique as jest.Mock).mockResolvedValue(codeRow());
  (prisma.mcpOAuthCode.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  (prisma.mcpOAuthToken.createMany as jest.Mock).mockResolvedValue({ count: 2 });
  (prisma.mcpOAuthToken.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(null);
  (prisma.mcpOAuthToken.findMany as jest.Mock).mockResolvedValue([]);
  (prisma.mcpOAuthToken.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
  const config = { get: (k: string) => (k === 'PUBLIC_BASE_URL' ? BASE : undefined) };
  const svc = new McpOAuthTokenService(prisma as unknown as PrismaService, config as any);
  return { svc, prisma };
}

function codeGrant(overrides: Record<string, unknown> = {}) {
  return {
    grant_type: 'authorization_code',
    code: 'raw-code',
    code_verifier: VERIFIER,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    ...overrides,
  };
}

async function oauthErrorOf(p: Promise<unknown>): Promise<{ status: number; error: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OAuthHttpException) {
      return { status: e.getStatus(), error: (e.getResponse() as any).error };
    }
    throw e;
  }
  throw new Error('expected the grant to be rejected');
}

/** The rows a `createMany` call was asked to write, by token type. */
function created(prisma: any, call = 0): Record<string, any> {
  const rows = (prisma.mcpOAuthToken.createMany as jest.Mock).mock.calls[call][0].data as any[];
  return Object.fromEntries(rows.map((r) => [r.type, r]));
}

describe('McpOAuthTokenService', () => {
  it('refuses an unsupported grant_type', async () => {
    const { svc } = make();
    expect(await oauthErrorOf(svc.grant({ grant_type: 'password' }))).toEqual({
      status: 400,
      error: 'unsupported_grant_type',
    });
  });

  describe('grant_type=authorization_code', () => {
    it('looks the code up by its HASH, never by the raw value', async () => {
      const { svc, prisma } = make();
      await svc.grant(codeGrant());
      expect(prisma.mcpOAuthCode.findUnique).toHaveBeenCalledWith({
        where: { codeHash: sha256Hex('raw-code') },
      });
    });

    it('rejects an unknown code', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthCode.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await oauthErrorOf(svc.grant(codeGrant()))).toEqual({
        status: 400,
        error: 'invalid_grant',
      });
    });

    it('rejects a code_verifier that does not hash to the stored challenge', async () => {
      const { svc } = make();
      // This is the entire point of PKCE: possession of the code is not enough.
      expect(await oauthErrorOf(svc.grant(codeGrant({ code_verifier: 'wrong-verifier' })))).toEqual({
        status: 400,
        error: 'invalid_grant',
      });
    });

    it('rejects a missing code_verifier', async () => {
      const { svc } = make();
      expect(await oauthErrorOf(svc.grant(codeGrant({ code_verifier: undefined })))).toEqual({
        status: 400,
        error: 'invalid_request',
      });
    });

    it('rejects an expired code', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthCode.findUnique as jest.Mock).mockResolvedValue(
        codeRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      expect(await oauthErrorOf(svc.grant(codeGrant()))).toEqual({
        status: 400,
        error: 'invalid_grant',
      });
    });

    it('rejects a redirect_uri other than the one bound to the code', async () => {
      const { svc } = make();
      expect(
        await oauthErrorOf(svc.grant(codeGrant({ redirect_uri: 'https://evil.example/cb' }))),
      ).toEqual({ status: 400, error: 'invalid_grant' });
    });

    it('rejects a client_id other than the one the code was issued to', async () => {
      const { svc } = make();
      expect(
        await oauthErrorOf(svc.grant(codeGrant({ client_id: 'https://evil.example/c.json' }))),
      ).toEqual({ status: 400, error: 'invalid_grant' });
    });

    it('returns a standard OAuth token response', async () => {
      const { svc } = make();
      const out = await svc.grant(codeGrant());
      expect(out).toMatchObject({
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'leads.read leads.write',
      });
      expect(typeof out.access_token).toBe('string');
      expect(typeof out.refresh_token).toBe('string');
    });

    it('never mints a token that could be mistaken for an API key', async () => {
      const { svc } = make();
      const out = await svc.grant(codeGrant());
      // The MCP verifier routes on the `mk_live_` prefix; an OAuth token that
      // started with it would be sent down the API-key path.
      expect(out.access_token.startsWith('mk_live_')).toBe(false);
      expect(out.refresh_token!.startsWith('mk_live_')).toBe(false);
    });

    it('stores both tokens HASHED, carrying audience, scopes, workspace and user', async () => {
      const { svc, prisma } = make();
      const out = await svc.grant(codeGrant());
      const rows = created(prisma);

      expect(rows.ACCESS.tokenHash).toBe(sha256Hex(out.access_token));
      expect(rows.REFRESH.tokenHash).toBe(sha256Hex(out.refresh_token!));
      const serialised = JSON.stringify(
        (prisma.mcpOAuthToken.createMany as jest.Mock).mock.calls[0][0],
      );
      expect(serialised).not.toContain(out.access_token);
      expect(serialised).not.toContain(out.refresh_token);

      for (const row of [rows.ACCESS, rows.REFRESH]) {
        expect(row).toMatchObject({
          clientId: CLIENT_ID,
          workspaceId: 'ws-1',
          userId: 'user-1',
          scopes: ['leads.read', 'leads.write'],
          // RFC 8707 — the audience travels from the code onto the token, which
          // is what lets the MCP transport refuse a token minted for elsewhere.
          resource: RESOURCE,
        });
      }
    });

    it('gives the access token ~1h and the refresh ~30d', async () => {
      const { svc, prisma } = make();
      await svc.grant(codeGrant());
      const rows = created(prisma);
      const hours = (d: Date) => (d.getTime() - Date.now()) / 3_600_000;
      expect(hours(rows.ACCESS.expiresAt)).toBeGreaterThan(0.9);
      expect(hours(rows.ACCESS.expiresAt)).toBeLessThan(1.1);
      expect(hours(rows.REFRESH.expiresAt)).toBeGreaterThan(29 * 24);
      expect(hours(rows.REFRESH.expiresAt)).toBeLessThan(31 * 24);
    });

    it('roots the new pair at the code so the whole family is reachable', async () => {
      const { svc, prisma } = make();
      await svc.grant(codeGrant());
      const rows = created(prisma);
      // parentId = the code's id. Replay defence walks parentId downwards, so
      // anchoring the first pair to the code is what makes "revoke everything
      // derived from this code" a single walk.
      expect(rows.ACCESS.parentId).toBe('code-1');
      expect(rows.REFRESH.parentId).toBe('code-1');
    });

    it('consumes the code ATOMICALLY, gated on it still being unconsumed', async () => {
      const { svc, prisma } = make();
      await svc.grant(codeGrant());
      // A read-then-write would let two concurrent exchanges of one code both
      // pass the "not consumed yet" read and both mint tokens.
      expect(prisma.mcpOAuthCode.updateMany).toHaveBeenCalledWith({
        where: { id: 'code-1', consumedAt: null },
        data: { consumedAt: expect.any(Date) },
      });
    });

    describe('replay defence', () => {
      it('rejects a second exchange of the same code', async () => {
        const { svc, prisma } = make();
        (prisma.mcpOAuthCode.findUnique as jest.Mock).mockResolvedValue(
          codeRow({ consumedAt: new Date() }),
        );
        expect(await oauthErrorOf(svc.grant(codeGrant()))).toEqual({
          status: 400,
          error: 'invalid_grant',
        });
        expect(prisma.mcpOAuthToken.createMany).not.toHaveBeenCalled();
      });

      it('revokes every token already derived from a replayed code', async () => {
        const { svc, prisma } = make();
        (prisma.mcpOAuthCode.findUnique as jest.Mock).mockResolvedValue(
          codeRow({ consumedAt: new Date() }),
        );
        (prisma.mcpOAuthToken.findMany as jest.Mock)
          .mockResolvedValueOnce([{ id: 'at-1' }, { id: 'rt-1' }])
          .mockResolvedValueOnce([{ id: 'at-2' }, { id: 'rt-2' }])
          .mockResolvedValue([]);

        await oauthErrorOf(svc.grant(codeGrant()));

        // A replay means the code leaked. The first exchange may well have been
        // the ATTACKER's, so the legitimate-looking tokens already out there
        // cannot be trusted either — the whole family dies.
        const revoked = (prisma.mcpOAuthToken.updateMany as jest.Mock).mock.calls[0][0];
        expect(revoked.where.id.in).toEqual(
          expect.arrayContaining(['code-1', 'at-1', 'rt-1', 'at-2', 'rt-2']),
        );
        expect(revoked.data.revokedAt).toBeInstanceOf(Date);
      });

      it('treats a lost consume race as a replay', async () => {
        const { svc, prisma } = make();
        // The row was unconsumed when we read it, but a concurrent exchange got
        // there first — the gated update matched nothing.
        (prisma.mcpOAuthCode.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
        expect(await oauthErrorOf(svc.grant(codeGrant()))).toEqual({
          status: 400,
          error: 'invalid_grant',
        });
        expect(prisma.mcpOAuthToken.createMany).not.toHaveBeenCalled();
        expect(prisma.mcpOAuthToken.updateMany).toHaveBeenCalled();
      });
    });
  });

  describe('grant_type=refresh_token', () => {
    const refreshGrant = (overrides: Record<string, unknown> = {}) => ({
      grant_type: 'refresh_token',
      refresh_token: 'raw-refresh',
      client_id: CLIENT_ID,
      ...overrides,
    });

    it('looks the refresh up by hash and type', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(refreshRow());
      await svc.grant(refreshGrant());
      expect(prisma.mcpOAuthToken.findFirst).toHaveBeenCalledWith({
        where: { tokenHash: sha256Hex('raw-refresh'), type: 'REFRESH' },
      });
    });

    it('rejects an unknown refresh token', async () => {
      const { svc } = make();
      expect(await oauthErrorOf(svc.grant(refreshGrant()))).toEqual({
        status: 400,
        error: 'invalid_grant',
      });
    });

    it('rejects an expired refresh token', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(
        refreshRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      expect(await oauthErrorOf(svc.grant(refreshGrant()))).toEqual({
        status: 400,
        error: 'invalid_grant',
      });
    });

    it('rejects a refresh presented by a different client', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(refreshRow());
      expect(
        await oauthErrorOf(svc.grant(refreshGrant({ client_id: 'https://evil.example/c.json' }))),
      ).toEqual({ status: 400, error: 'invalid_grant' });
    });

    it('ROTATES: the presented refresh is revoked and a new pair issued', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(refreshRow());
      const out = await svc.grant(refreshGrant());

      expect(out.refresh_token).toBeTruthy();
      // The old refresh is single-use — that is what makes a leaked refresh
      // detectable at all (the legitimate client's next use collides).
      expect(prisma.mcpOAuthToken.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('links the new pair to the one it replaced via parentId', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(refreshRow());
      await svc.grant(refreshGrant());
      const rows = created(prisma);
      expect(rows.ACCESS.parentId).toBe('rt-1');
      expect(rows.REFRESH.parentId).toBe('rt-1');
    });

    it('carries the original scopes, audience, workspace and user forward', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(refreshRow());
      const out = await svc.grant(refreshGrant());
      expect(out.scope).toBe('leads.read');
      expect(created(prisma).ACCESS).toMatchObject({
        workspaceId: 'ws-1',
        userId: 'user-1',
        resource: RESOURCE,
        scopes: ['leads.read'],
      });
    });

    it('revokes the WHOLE chain when an already-revoked refresh is presented', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(
        refreshRow({ revokedAt: new Date() }),
      );
      // Walking up: rt-1's parent is the code (no token row), so the family root
      // is the code id and the walk down from there catches every generation.
      (prisma.mcpOAuthToken.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.mcpOAuthToken.findMany as jest.Mock)
        .mockResolvedValueOnce([{ id: 'at-1' }, { id: 'rt-1' }])
        .mockResolvedValueOnce([{ id: 'at-2' }, { id: 'rt-2' }])
        .mockResolvedValue([]);

      expect(await oauthErrorOf(svc.grant(refreshGrant()))).toEqual({
        status: 400,
        error: 'invalid_grant',
      });

      // Reuse of a rotated refresh means either the client or an attacker holds
      // a stale copy, and we cannot tell which — so neither keeps access.
      const revoked = (prisma.mcpOAuthToken.updateMany as jest.Mock).mock.calls[0][0];
      expect(revoked.where.id.in).toEqual(
        expect.arrayContaining(['code-1', 'at-1', 'rt-1', 'at-2', 'rt-2']),
      );
      expect(prisma.mcpOAuthToken.createMany).not.toHaveBeenCalled();
    });

    it('walks the chain from the topmost token when there is no code root', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthToken.findFirst as jest.Mock).mockResolvedValue(
        refreshRow({ id: 'rt-2', parentId: 'rt-1', revokedAt: new Date() }),
      );
      (prisma.mcpOAuthToken.findUnique as jest.Mock).mockResolvedValue({
        id: 'rt-1',
        parentId: null,
      });
      (prisma.mcpOAuthToken.findMany as jest.Mock).mockResolvedValue([]);

      await oauthErrorOf(svc.grant(refreshGrant()));

      const revoked = (prisma.mcpOAuthToken.updateMany as jest.Mock).mock.calls[0][0];
      expect(revoked.where.id.in).toEqual(expect.arrayContaining(['rt-1']));
    });

    it('rejects a missing refresh_token', async () => {
      const { svc } = make();
      expect(await oauthErrorOf(svc.grant(refreshGrant({ refresh_token: undefined })))).toEqual({
        status: 400,
        error: 'invalid_request',
      });
    });
  });
});
