import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { PrismaClient } from '@prisma/client';
import { CimdClientService, CimdError } from './cimd-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { safeFetch } from '../../common/util/safe-fetch';

/**
 * `client_id` is an arbitrary external URL supplied by an unauthenticated
 * caller, so the fetch MUST go through the SSRF-hardened helper. Mocking the
 * module (rather than global.fetch) both keeps the unit test offline — the real
 * safeFetch does a live DNS lookup — and lets us prove the helper is what got
 * called: every test also asserts plain fetch was never used.
 */
jest.mock('../../common/util/safe-fetch', () => ({
  safeFetch: jest.fn(),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const safeFetchMock = safeFetch as jest.Mock;

const CLIENT_ID = 'https://claude.ai/mcp/client-metadata.json';

const DOC = {
  client_id: CLIENT_ID,
  client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  logo_uri: 'https://claude.ai/logo.png',
};

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function make(): { svc: CimdClientService; prisma: DeepMockProxy<PrismaClient> } {
  const prisma = mockDeep<PrismaClient>();
  // Default: nothing cached, and the upsert echoes back what it was told.
  (prisma.mcpOAuthClient.findUnique as jest.Mock).mockResolvedValue(null);
  (prisma.mcpOAuthClient.upsert as jest.Mock).mockImplementation(async (args: any) => ({
    id: 'row-1',
    clientId: args.where.clientId,
    ...args.create,
  }));
  return { svc: new CimdClientService(prisma as unknown as PrismaService), prisma };
}

describe('CimdClientService.resolveClient', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchSpy = jest.spyOn(global, 'fetch' as any).mockImplementation(() => {
      throw new Error('plain fetch must never be used for a caller-supplied URL');
    });
  });

  afterEach(() => fetchSpy.mockRestore());

  describe('client_id shape', () => {
    it.each([
      ['http (not https)', 'http://claude.ai/client.json'],
      ['not a URL at all', 'claude-desktop'],
      ['a non-http scheme', 'file:///etc/passwd'],
      ['a URN', 'urn:ietf:params:oauth:client:claude'],
      ['credentials in the authority', 'https://user:pw@claude.ai/client.json'],
      ['a fragment', 'https://claude.ai/client.json#frag'],
      ['empty', ''],
    ])('rejects %s', async (_label, clientId) => {
      const { svc } = make();
      await expect(svc.resolveClient(clientId)).rejects.toBeInstanceOf(CimdError);
      expect(safeFetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fetching the document', () => {
    it('fetches through safeFetch, never plain fetch', async () => {
      const { svc } = make();
      safeFetchMock.mockResolvedValue(jsonResponse(DOC));
      await svc.resolveClient(CLIENT_ID);
      expect(safeFetchMock).toHaveBeenCalledTimes(1);
      expect(safeFetchMock.mock.calls[0][0]).toBe(CLIENT_ID);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a non-2xx response', async () => {
      const { svc } = make();
      safeFetchMock.mockResolvedValue(jsonResponse({}, { status: 404 }));
      await expect(svc.resolveClient(CLIENT_ID)).rejects.toBeInstanceOf(CimdError);
    });

    it('rejects a body that is not JSON', async () => {
      const { svc } = make();
      safeFetchMock.mockResolvedValue(jsonResponse('<html>nope</html>'));
      await expect(svc.resolveClient(CLIENT_ID)).rejects.toBeInstanceOf(CimdError);
    });

    it('rejects when the SSRF guard blocks the URL', async () => {
      const { svc } = make();
      safeFetchMock.mockRejectedValue(new Error('blocked IP literal'));
      await expect(svc.resolveClient(CLIENT_ID)).rejects.toBeInstanceOf(CimdError);
    });
  });

  describe('document validation', () => {
    it("rejects a document whose own client_id isn't the URL we fetched", async () => {
      // The whole security property of CIMD: without this, anyone could host a
      // document claiming to be someone else's client.
      const { svc } = make();
      safeFetchMock.mockResolvedValue(jsonResponse({ ...DOC, client_id: 'https://evil.example/c' }));
      await expect(svc.resolveClient(CLIENT_ID)).rejects.toBeInstanceOf(CimdError);
    });

    it('requires an EXACT match — a trailing slash is a different client_id', async () => {
      const { svc } = make();
      safeFetchMock.mockResolvedValue(jsonResponse({ ...DOC, client_id: `${CLIENT_ID}/` }));
      await expect(svc.resolveClient(CLIENT_ID)).rejects.toBeInstanceOf(CimdError);
    });

    it.each([
      ['missing', {}],
      ['not an array', { redirect_uris: 'https://claude.ai/cb' }],
      ['empty', { redirect_uris: [] }],
      ['containing a non-string', { redirect_uris: ['https://claude.ai/cb', 42] }],
    ])('rejects redirect_uris %s', async (_label, patch) => {
      const { svc } = make();
      const { redirect_uris, ...rest } = DOC;
      safeFetchMock.mockResolvedValue(jsonResponse({ ...rest, ...patch }));
      await expect(svc.resolveClient(CLIENT_ID)).rejects.toBeInstanceOf(CimdError);
    });

    it('returns the validated client on success', async () => {
      const { svc } = make();
      safeFetchMock.mockResolvedValue(jsonResponse(DOC));
      const client = await svc.resolveClient(CLIENT_ID);
      expect(client).toMatchObject({
        clientId: CLIENT_ID,
        clientName: 'Claude',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      });
    });
  });

  describe('caching', () => {
    it('persists the document keyed by client_id', async () => {
      const { svc, prisma } = make();
      safeFetchMock.mockResolvedValue(jsonResponse(DOC));
      await svc.resolveClient(CLIENT_ID);

      const args = (prisma.mcpOAuthClient.upsert as jest.Mock).mock.calls[0][0];
      expect(args.where).toEqual({ clientId: CLIENT_ID });
      expect(args.create).toMatchObject({
        clientId: CLIENT_ID,
        clientName: 'Claude',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      });
      // Everything else on the document is kept, but not duplicated.
      expect(args.create.metadata).toMatchObject({ logo_uri: 'https://claude.ai/logo.png' });
      expect(args.create.metadata).not.toHaveProperty('client_id');
    });

    it('serves a live cache row without re-fetching', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthClient.findUnique as jest.Mock).mockResolvedValue({
        id: 'row-1',
        clientId: CLIENT_ID,
        clientName: 'Cached Claude',
        redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
        metadata: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      const client = await svc.resolveClient(CLIENT_ID);
      expect(client.clientName).toBe('Cached Claude');
      expect(safeFetchMock).not.toHaveBeenCalled();
    });

    it('re-fetches once the cached row has lapsed', async () => {
      const { svc, prisma } = make();
      (prisma.mcpOAuthClient.findUnique as jest.Mock).mockResolvedValue({
        id: 'row-1',
        clientId: CLIENT_ID,
        clientName: 'Stale Claude',
        redirectUris: ['https://claude.ai/old'],
        metadata: null,
        expiresAt: new Date(Date.now() - 1_000),
      });
      safeFetchMock.mockResolvedValue(jsonResponse(DOC));

      const client = await svc.resolveClient(CLIENT_ID);
      expect(safeFetchMock).toHaveBeenCalledTimes(1);
      expect(client.clientName).toBe('Claude');
    });

    it("honours the response's Cache-Control max-age", async () => {
      const { svc, prisma } = make();
      safeFetchMock.mockResolvedValue(
        jsonResponse(DOC, { headers: { 'cache-control': 'public, max-age=7200' } }),
      );
      const before = Date.now();
      await svc.resolveClient(CLIENT_ID);

      const { expiresAt } = (prisma.mcpOAuthClient.upsert as jest.Mock).mock.calls[0][0].create;
      expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(7200_000 - 2_000);
      expect(expiresAt.getTime() - before).toBeLessThanOrEqual(7200_000 + 2_000);
    });

    it('falls back to an hour when the response says nothing', async () => {
      const { svc, prisma } = make();
      safeFetchMock.mockResolvedValue(jsonResponse(DOC));
      const before = Date.now();
      await svc.resolveClient(CLIENT_ID);

      const { expiresAt } = (prisma.mcpOAuthClient.upsert as jest.Mock).mock.calls[0][0].create;
      expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(3600_000 - 2_000);
      expect(expiresAt.getTime() - before).toBeLessThanOrEqual(3600_000 + 2_000);
    });

    it.each([
      ['an absurd max-age is capped at 24h', 'max-age=999999999', 24 * 3600_000],
      ['max-age=0 still gets a short floor', 'max-age=0', 60_000],
      ['no-store still gets a short floor', 'no-store', 60_000],
    ])('%s', async (_label, cacheControl, expected) => {
      // The client controls this header, so it must not be able to pin a
      // document (possibly a compromised one) forever, nor make us re-fetch on
      // every single authorization request.
      const { svc, prisma } = make();
      safeFetchMock.mockResolvedValue(jsonResponse(DOC, { headers: { 'cache-control': cacheControl } }));
      const before = Date.now();
      await svc.resolveClient(CLIENT_ID);

      const { expiresAt } = (prisma.mcpOAuthClient.upsert as jest.Mock).mock.calls[0][0].create;
      expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(expected - 2_000);
      expect(expiresAt.getTime() - before).toBeLessThanOrEqual(expected + 2_000);
    });
  });
});
