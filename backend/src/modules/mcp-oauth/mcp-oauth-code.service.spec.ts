import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { McpOAuthCodeService } from './mcp-oauth-code.service';
import { OAuthHttpException } from './mcp-oauth.errors';
import { PrismaService } from '../../prisma/prisma.service';

const BASE = 'https://jeeta.example.com';
const RESOURCE = `${BASE}/api/mcp`;
const CLIENT_ID = 'https://claude.ai/mcp/client-metadata.json';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
/** A real RFC 7636 §4.2 S256 challenge (the value is irrelevant to authorize). */
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const USER = 'user-1';
const WS = 'ws-1';

function make() {
  const prisma = mockDeep<PrismaClient>();
  (prisma.mcpOAuthCode.create as jest.Mock).mockImplementation(async (args: any) => ({
    id: 'code-row-1',
    ...args.data,
  }));
  const cimd = {
    resolveClient: jest.fn().mockResolvedValue({
      clientId: CLIENT_ID,
      clientName: 'Claude',
      redirectUris: [REDIRECT],
      metadata: { logo_uri: 'https://claude.ai/logo.png' },
    }),
  };
  const memberships = {
    getActiveMembership: jest.fn().mockResolvedValue({
      id: 'm1',
      workspaceId: WS,
      role: 'MANAGER',
      customRoleId: null,
    }),
    listActiveMemberships: jest
      .fn()
      .mockResolvedValue([{ workspaceId: WS, workspaceName: 'Acme', role: 'MANAGER' }]),
  };
  const roles = {
    resolvePermissions: jest
      .fn()
      .mockResolvedValue(['leads.read', 'leads.write', 'reports.read']),
  };
  const config = { get: (k: string) => (k === 'PUBLIC_BASE_URL' ? BASE : undefined) };
  const svc = new McpOAuthCodeService(
    prisma as unknown as PrismaService,
    cimd as any,
    memberships as any,
    roles as any,
    config as any,
  );
  return { svc, prisma, cimd, memberships, roles };
}

function query(overrides: Record<string, unknown> = {}) {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    scope: 'leads.read leads.write',
    state: 'st-1',
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
  throw new Error('expected the request to be rejected');
}

describe('McpOAuthCodeService', () => {
  describe('validate — the authorization request', () => {
    it('rejects a request with no code_challenge (PKCE is mandatory)', async () => {
      const { svc } = make();
      // OAuth 2.1 makes PKCE mandatory for every client. Without it a stolen
      // authorization code is directly redeemable by whoever intercepted it.
      expect(await oauthErrorOf(svc.validate(query({ code_challenge: undefined })))).toEqual({
        status: 400,
        error: 'invalid_request',
      });
    });

    it('rejects code_challenge_method=plain', async () => {
      const { svc } = make();
      // `plain` puts the verifier itself in the authorization request, so an
      // attacker who can read that request can complete the exchange.
      expect(
        await oauthErrorOf(svc.validate(query({ code_challenge_method: 'plain' }))),
      ).toEqual({ status: 400, error: 'invalid_request' });
    });

    it('defaults nothing: an absent code_challenge_method is still refused', async () => {
      const { svc } = make();
      // RFC 7636 defaults a missing method to `plain`. Refuse rather than
      // silently inherit that default.
      expect(
        await oauthErrorOf(svc.validate(query({ code_challenge_method: undefined }))),
      ).toEqual({ status: 400, error: 'invalid_request' });
    });

    it('rejects a redirect_uri the CIMD document does not declare', async () => {
      const { svc } = make();
      expect(
        await oauthErrorOf(
          svc.validate(query({ redirect_uri: 'https://evil.example/callback' })),
        ),
      ).toEqual({ status: 400, error: 'invalid_request' });
    });

    it('matches redirect_uri exactly — no prefix or normalisation slack', async () => {
      const { svc } = make();
      expect(await oauthErrorOf(svc.validate(query({ redirect_uri: `${REDIRECT}/x` })))).toEqual({
        status: 400,
        error: 'invalid_request',
      });
    });

    it('rejects a resource that is not our canonical MCP URI (RFC 8707)', async () => {
      const { svc } = make();
      // Without this the user could be talked into minting a token for someone
      // else's resource server, which is exactly what resource indicators exist
      // to prevent.
      expect(
        await oauthErrorOf(svc.validate(query({ resource: 'https://evil.example/api/mcp' }))),
      ).toEqual({ status: 400, error: 'invalid_target' });
    });

    it('rejects a missing resource', async () => {
      const { svc } = make();
      expect(await oauthErrorOf(svc.validate(query({ resource: undefined })))).toEqual({
        status: 400,
        error: 'invalid_target',
      });
    });

    it('rejects a scope outside the MCP vocabulary', async () => {
      const { svc } = make();
      expect(await oauthErrorOf(svc.validate(query({ scope: 'leads.read billing.manage' })))).toEqual(
        { status: 400, error: 'invalid_scope' },
      );
    });

    it('rejects response_type other than code', async () => {
      const { svc } = make();
      expect(await oauthErrorOf(svc.validate(query({ response_type: 'token' })))).toEqual({
        status: 400,
        error: 'unsupported_response_type',
      });
    });

    it('resolves the client through CIMD and returns the validated request', async () => {
      const { svc, cimd } = make();
      const req = await svc.validate(query());
      expect(cimd.resolveClient).toHaveBeenCalledWith(CLIENT_ID);
      expect(req).toMatchObject({
        clientId: CLIENT_ID,
        redirectUri: REDIRECT,
        resource: RESOURCE,
        codeChallenge: CHALLENGE,
        requestedScopes: ['leads.read', 'leads.write'],
        state: 'st-1',
      });
    });
  });

  describe('consentData — what the consent screen renders', () => {
    it('returns the client name, the requested scopes and the user’s workspaces', async () => {
      const { svc } = make();
      const data = await svc.consentData(await svc.validate(query()), USER);
      expect(data.client).toMatchObject({ clientId: CLIENT_ID, clientName: 'Claude' });
      expect(data.requestedScopes).toEqual(['leads.read', 'leads.write']);
      expect(data.workspaces).toEqual([
        {
          workspaceId: WS,
          workspaceName: 'Acme',
          role: 'MANAGER',
          grantableScopes: ['leads.read', 'leads.write'],
        },
      ]);
    });

    it('narrows the grantable scopes per workspace to what the caller actually holds', async () => {
      const { svc, roles } = make();
      roles.resolvePermissions.mockResolvedValue(['leads.read']);
      const data = await svc.consentData(await svc.validate(query()), USER);
      expect(data.workspaces[0].grantableScopes).toEqual(['leads.read']);
    });

    it('does NOT mint a code', async () => {
      const { svc, prisma } = make();
      await svc.consentData(await svc.validate(query()), USER);
      expect(prisma.mcpOAuthCode.create).not.toHaveBeenCalled();
    });
  });

  describe('grant — the consent POST', () => {
    it('stores the code HASHED and never in the clear', async () => {
      const { svc, prisma } = make();
      const req = await svc.validate(query());
      const out = await svc.grant(req, USER, { workspaceId: WS, scopes: ['leads.read'] });

      const data = (prisma.mcpOAuthCode.create as jest.Mock).mock.calls[0][0].data;
      expect(data.codeHash).toBe(createHash('sha256').update(out.code).digest('hex'));
      // Same convention as ApiKeysService: the raw secret never reaches the row.
      expect(JSON.stringify(data)).not.toContain(out.code);
    });

    it('binds the code to the user, workspace, client, redirect_uri, resource and challenge', async () => {
      const { svc, prisma } = make();
      const req = await svc.validate(query());
      await svc.grant(req, USER, { workspaceId: WS, scopes: ['leads.read'] });

      expect((prisma.mcpOAuthCode.create as jest.Mock).mock.calls[0][0].data).toMatchObject({
        clientId: CLIENT_ID,
        workspaceId: WS,
        userId: USER,
        redirectUri: REDIRECT,
        resource: RESOURCE,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        scopes: ['leads.read'],
      });
    });

    it('gives the code a short life and leaves it unconsumed', async () => {
      const { svc, prisma } = make();
      const req = await svc.validate(query());
      await svc.grant(req, USER, { workspaceId: WS, scopes: ['leads.read'] });

      const data = (prisma.mcpOAuthCode.create as jest.Mock).mock.calls[0][0].data;
      const ttlMs = data.expiresAt.getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(0);
      expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000);
      expect(data.consumedAt ?? null).toBeNull();
    });

    it('returns a redirect carrying code, state and iss (RFC 9207)', async () => {
      const { svc } = make();
      const req = await svc.validate(query());
      const { redirectTo, code } = await svc.grant(req, USER, {
        workspaceId: WS,
        scopes: ['leads.read'],
      });

      const url = new URL(redirectTo);
      expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
      expect(url.searchParams.get('code')).toBe(code);
      expect(url.searchParams.get('state')).toBe('st-1');
      // RFC 9207 — without `iss` the client cannot tell which authorization
      // server answered, which is the whole mix-up attack.
      expect(url.searchParams.get('iss')).toBe(BASE);
    });

    it('refuses a workspace the caller is not an ACTIVE member of', async () => {
      const { svc, memberships } = make();
      memberships.getActiveMembership.mockResolvedValue(null);
      const req = await svc.validate(query());
      expect(
        await oauthErrorOf(svc.grant(req, USER, { workspaceId: 'ws-other', scopes: ['leads.read'] })),
      ).toEqual({ status: 403, error: 'access_denied' });
    });

    it('refuses a scope the caller does not hold in that workspace', async () => {
      const { svc, roles } = make();
      roles.resolvePermissions.mockResolvedValue(['leads.read']);
      const req = await svc.validate(query());
      // The consent screen offers `leads.write`, but a REP-shaped permission set
      // does not hold it — consent cannot manufacture authority.
      expect(
        await oauthErrorOf(svc.grant(req, USER, { workspaceId: WS, scopes: ['leads.write'] })),
      ).toEqual({ status: 403, error: 'access_denied' });
    });

    it('refuses a scope the client never asked for', async () => {
      const { svc } = make();
      const req = await svc.validate(query());
      expect(
        await oauthErrorOf(svc.grant(req, USER, { workspaceId: WS, scopes: ['reports.read'] })),
      ).toEqual({ status: 400, error: 'invalid_scope' });
    });

    it('refuses an empty grant', async () => {
      const { svc } = make();
      const req = await svc.validate(query());
      expect(await oauthErrorOf(svc.grant(req, USER, { workspaceId: WS, scopes: [] }))).toEqual({
        status: 400,
        error: 'invalid_scope',
      });
    });

    it('resolves the caller’s permissions from the MEMBERSHIP, not the home role', async () => {
      const { svc, memberships, roles } = make();
      memberships.getActiveMembership.mockResolvedValue({
        id: 'm2',
        workspaceId: WS,
        role: 'REP',
        customRoleId: 'cr-9',
      });
      const req = await svc.validate(query());
      await svc.grant(req, USER, { workspaceId: WS, scopes: ['leads.read'] });
      expect(roles.resolvePermissions).toHaveBeenCalledWith({
        workspaceId: WS,
        role: 'REP',
        customRoleId: 'cr-9',
      });
    });
  });
});
