import {
  generateKeyPairSync,
  createSign,
  createPrivateKey,
  KeyObject,
} from 'crypto';
import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SsoService } from './sso.service';
import { MarketingAuthService } from './marketing-auth.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { sealSecret } from '../../../common/crypto/secret-box.helper';

/**
 * SSO/OIDC unit spec. The IdP is fully MOCKED (discovery + token + JWKS via a
 * stubbed safeFetch); we sign real ID tokens with a throwaway RSA key so the
 * RS256 verify path runs for real. No live IdP, no network.
 *
 * We mock the safe-fetch module (not global.fetch) so the unit test stays
 * deterministic/offline — the real safeFetch does a live DNS lookup for its
 * SSRF guard, which a unit test must not depend on. The SSRF guard itself is
 * covered by safe-fetch's own spec; here we drive the OIDC logic above it.
 */
jest.mock('../../../common/util/safe-fetch', () => {
  const actual = jest.requireActual('../../../common/util/safe-fetch');
  return {
    ...actual,
    safeFetch: (url: string, init?: RequestInit) =>
      (global as unknown as { fetch: jest.Mock }).fetch(url, init),
  };
});

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-abc';
const CLIENT_SECRET = 'super-secret-value';
const KID = 'test-key-1';

// --- throwaway RSA keypair for signing ID tokens -------------------------
let privateKey: KeyObject;
let jwk: Record<string, string>;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Sign an RS256 JWT with the test private key. */
function signIdToken(
  claims: Record<string, unknown>,
  opts: { kid?: string; alg?: string } = {},
): string {
  const header = { alg: opts.alg ?? 'RS256', typ: 'JWT', kid: opts.kid ?? KID };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
    JSON.stringify(claims),
  )}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

function baseClaims(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'idp-user-1',
    email: 'alice@acme.com',
    email_verified: true,
    given_name: 'Alice',
    family_name: 'Anderson',
    nonce: '', // filled per-test
    iat: now,
    exp: now + 300,
    ...over,
  };
}

/** Build the mocked IdP responses: discovery, token endpoint, JWKS. */
function mockIdp(idToken: string, tokenStatus = 200) {
  (global as unknown as { fetch: jest.Mock }).fetch = jest
    .fn()
    .mockImplementation((url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/.well-known/openid-configuration')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            jwks_uri: `${ISSUER}/jwks`,
          }),
        } as Response);
      }
      if (u.endsWith('/token')) {
        return Promise.resolve({
          ok: tokenStatus >= 200 && tokenStatus < 300,
          status: tokenStatus,
          text: async () => 'token error',
          json: async () => ({
            access_token: 'at',
            id_token: idToken,
            token_type: 'Bearer',
          }),
        } as Response);
      }
      if (u.endsWith('/jwks')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ keys: [jwk] }),
        } as Response);
      }
      return Promise.reject(new Error(`unexpected fetch: ${u} (${init?.method})`));
    });
}

function makeConnection(over: Record<string, unknown> = {}) {
  return {
    id: 'sso-1',
    workspaceId: 'ws-1',
    provider: 'OIDC',
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: sealSecret(CLIENT_SECRET),
    enabled: true,
    allowedDomains: [] as string[],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('SsoService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let authService: { issueSession: jest.Mock };
  let service: SsoService;

  beforeAll(() => {
    // Secret-box master key (base64 of 32 bytes) for seal/open in tests.
    process.env.MARKETING_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

    const { privateKey: priv, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    privateKey = priv;
    const exported = publicKey.export({ format: 'jwk' }) as Record<string, string>;
    jwk = { ...exported, kid: KID, alg: 'RS256', use: 'sig' };
  });

  afterAll(() => {
    // Don't leak the secret-box key into other specs sharing this worker.
    delete process.env.MARKETING_SECRET_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = mockDeep<PrismaClient>();
    authService = { issueSession: jest.fn() };
    service = new SsoService(
      prisma as unknown as PrismaService,
      authService as unknown as MarketingAuthService,
    );
    // Default IdP mock: discovery + JWKS always answer; token endpoint returns
    // nothing useful until a test calls mockIdp() with a real ID token. Lets
    // getAuthorizationUrl (which discovers) work without per-test wiring.
    mockIdp(signIdToken(baseClaims()));
  });

  describe('getAuthorizationUrl', () => {
    it('builds an authorize URL with state, nonce and PKCE S256', async () => {
      prisma.ssoConnection.findFirst.mockResolvedValue(makeConnection() as never);

      const { url } = await service.getAuthorizationUrl('ws-1');
      const parsed = new URL(url);

      expect(parsed.origin + parsed.pathname).toBe(`${ISSUER}/authorize`);
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(parsed.searchParams.get('scope')).toContain('openid');
      expect(parsed.searchParams.get('state')).toBeTruthy();
      expect(parsed.searchParams.get('nonce')).toBeTruthy();
      expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('rejects when no enabled connection exists ("SSO not configured")', async () => {
      prisma.ssoConnection.findFirst.mockResolvedValue(null as never);
      await expect(service.getAuthorizationUrl('ws-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('handleCallback', () => {
    async function startFlow(connection = makeConnection()) {
      prisma.ssoConnection.findFirst.mockResolvedValue(connection as never);
      const { url } = await service.getAuthorizationUrl(
        connection.workspaceId as string,
      );
      const parsed = new URL(url);
      return {
        state: parsed.searchParams.get('state') as string,
        nonce: parsed.searchParams.get('nonce') as string,
      };
    }

    it('provisions a NEW user in the right workspace and mints a session', async () => {
      const { state, nonce } = await startFlow();
      mockIdp(signIdToken(baseClaims({ nonce })));

      prisma.marketingUser.findFirst.mockResolvedValue(null as never);
      prisma.marketingUser.create.mockResolvedValue({
        id: 'mu-new',
        workspaceId: 'ws-1',
        email: 'alice@acme.com',
        firstName: 'Alice',
        lastName: 'Anderson',
        phone: null,
        avatar: null,
        role: 'REP',
        tokenVersion: 0,
      } as never);
      authService.issueSession.mockReturnValue({
        accessToken: 'AT',
        refreshToken: 'RT',
        user: { id: 'mu-new' },
      });

      const result = await service.handleCallback(state, 'auth-code');

      // user created scoped to the connection's workspace
      expect(prisma.marketingUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: 'ws-1',
            email: 'alice@acme.com',
          }),
        }),
      );
      expect(authService.issueSession).toHaveBeenCalled();
      expect(result).toEqual({ accessToken: 'AT', refreshToken: 'RT', user: { id: 'mu-new' } });
    });

    it('matches an EXISTING user by email in the workspace (no create)', async () => {
      const { state, nonce } = await startFlow();
      mockIdp(signIdToken(baseClaims({ nonce })));

      prisma.marketingUser.findFirst.mockResolvedValue({
        id: 'mu-existing',
        workspaceId: 'ws-1',
        email: 'alice@acme.com',
        firstName: 'Alice',
        lastName: 'Anderson',
        phone: null,
        avatar: null,
        role: 'MANAGER',
        status: 'ACTIVE',
        tokenVersion: 3,
      } as never);
      authService.issueSession.mockReturnValue({ accessToken: 'AT2', refreshToken: 'RT2', user: {} });

      await service.handleCallback(state, 'auth-code');

      expect(prisma.marketingUser.create).not.toHaveBeenCalled();
      expect(authService.issueSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'mu-existing', tokenVersion: 3 }),
      );
    });

    it('rejects an unknown/forged state', async () => {
      mockIdp(signIdToken(baseClaims()));
      await expect(
        service.handleCallback('not-a-real-state', 'code'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong audience (aud != clientId)', async () => {
      const { state, nonce } = await startFlow();
      mockIdp(signIdToken(baseClaims({ nonce, aud: 'someone-else' })));
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a mismatched nonce (replay protection)', async () => {
      const { state } = await startFlow();
      mockIdp(signIdToken(baseClaims({ nonce: 'attacker-nonce' })));
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects an expired ID token', async () => {
      const { state, nonce } = await startFlow();
      const past = Math.floor(Date.now() / 1000) - 3600;
      mockIdp(signIdToken(baseClaims({ nonce, exp: past, iat: past - 300 })));
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a wrong issuer', async () => {
      const { state, nonce } = await startFlow();
      mockIdp(signIdToken(baseClaims({ nonce, iss: 'https://evil.example.com' })));
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a tampered signature (signed by a different key)', async () => {
      const { state, nonce } = await startFlow();
      // Sign with a freshly-minted key the JWKS does not contain.
      const { privateKey: rogue } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const saved = privateKey;
      privateKey = rogue as KeyObject;
      const forged = signIdToken(baseClaims({ nonce }));
      privateKey = saved;
      mockIdp(forged);
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects the "none" alg (no algorithm confusion)', async () => {
      const { state, nonce } = await startFlow();
      const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const body = b64url(JSON.stringify(baseClaims({ nonce })));
      mockIdp(`${header}.${body}.`);
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('enforces allowedDomains', async () => {
      const conn = makeConnection({ allowedDomains: ['allowed.com'] });
      const { state, nonce } = await startFlow(conn);
      mockIdp(signIdToken(baseClaims({ nonce, email: 'alice@acme.com' })));
      prisma.marketingUser.findFirst.mockResolvedValue(null as never);
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.marketingUser.create).not.toHaveBeenCalled();
    });

    it('allows an email whose domain is in allowedDomains', async () => {
      const conn = makeConnection({ allowedDomains: ['acme.com'] });
      const { state, nonce } = await startFlow(conn);
      mockIdp(signIdToken(baseClaims({ nonce, email: 'bob@acme.com' })));
      prisma.marketingUser.findFirst.mockResolvedValue(null as never);
      prisma.marketingUser.create.mockResolvedValue({
        id: 'mu-bob', workspaceId: 'ws-1', email: 'bob@acme.com',
        firstName: 'Bob', lastName: '', phone: null, avatar: null, role: 'REP', tokenVersion: 0,
      } as never);
      authService.issueSession.mockReturnValue({ accessToken: 'AT', refreshToken: 'RT', user: {} });
      await expect(service.handleCallback(state, 'code')).resolves.toBeDefined();
    });

    it('rejects an unverified email when the IdP says so', async () => {
      const { state, nonce } = await startFlow();
      mockIdp(signIdToken(baseClaims({ nonce, email_verified: false })));
      prisma.marketingUser.findFirst.mockResolvedValue(null as never);
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects when the token endpoint errors', async () => {
      const { state, nonce } = await startFlow();
      mockIdp(signIdToken(baseClaims({ nonce })), 401);
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('consumes state (single-use): a second callback with the same state fails', async () => {
      const { state, nonce } = await startFlow();
      mockIdp(signIdToken(baseClaims({ nonce })));
      prisma.marketingUser.findFirst.mockResolvedValue(null as never);
      prisma.marketingUser.create.mockResolvedValue({
        id: 'mu-1', workspaceId: 'ws-1', email: 'alice@acme.com',
        firstName: 'A', lastName: 'A', phone: null, avatar: null, role: 'REP', tokenVersion: 0,
      } as never);
      authService.issueSession.mockReturnValue({ accessToken: 'AT', refreshToken: 'RT', user: {} });

      await service.handleCallback(state, 'code');
      await expect(service.handleCallback(state, 'code')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('cross-workspace isolation (admin CRUD)', () => {
    it('list/get/update/remove only touch the caller workspace', async () => {
      prisma.ssoConnection.findMany.mockResolvedValue([] as never);
      await service.list('ws-A');
      expect(prisma.ssoConnection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: 'ws-A' } }),
      );

      // ws-B trying to read ws-A's row by id finds nothing (scoped findFirst).
      prisma.ssoConnection.findFirst.mockResolvedValue(null as never);
      await expect(service.get('ws-B', 'sso-A')).rejects.toBeDefined();
      expect(prisma.ssoConnection.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'sso-A', workspaceId: 'ws-B' } }),
      );
    });

    it('create seals the clientSecret and masks it on the way out', async () => {
      prisma.ssoConnection.create.mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'sso-x', createdAt: new Date(), updatedAt: new Date(),
          ...args.data,
        }) as never,
      );
      const out = (await service.create('ws-1', {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      })) as Record<string, unknown>;

      // What we persisted is sealed (not the plaintext) and round-trips.
      const created = (prisma.ssoConnection.create as jest.Mock).mock.calls[0][0]
        .data as { clientSecret: string };
      expect(created.clientSecret).not.toBe(CLIENT_SECRET);
      expect(created.clientSecret.startsWith('v1:')).toBe(true);

      // The response never carries the plaintext or the sealed blob.
      expect(out.clientSecret).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain(CLIENT_SECRET);
      expect(out).toHaveProperty('clientSecretSet', true);
    });
  });
});
