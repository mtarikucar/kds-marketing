import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';
import { sha256Hex } from '../../src/modules/mcp-oauth/mcp-oauth.crypto';
import { McpToolRegistry } from '../../src/modules/marketing/mcp/mcp-tool-registry';
import { safeFetch } from '../../src/common/util/safe-fetch';

// The CIMD lookup is the one outbound call in this flow. Mocked at the
// `safeFetch` seam rather than at `globalThis.fetch`, because safeFetch's SSRF
// guard DNS-resolves the host FIRST — a made-up test hostname never reaches
// fetch at all, and every CIMD assertion would collapse into the same
// "could not fetch" branch regardless of what the document said.
jest.mock('../../src/common/util/safe-fetch', () => ({
  ...jest.requireActual('../../src/common/util/safe-fetch'),
  safeFetch: jest.fn(),
}));
const safeFetchMock = safeFetch as jest.MockedFunction<typeof safeFetch>;

/**
 * MCP OAuth 2.1 authorization server — end-to-end (design §10).
 *
 * Everything here runs through the REAL `AppModule` + `configureApp`, which is
 * the point: each of these four properties depends on wiring that unit tests
 * cannot see.
 *
 *  1. **Discovery lives at the ROOT.** `setGlobalPrefix('api')` applies to
 *     every route without exception; only the exclusion list keeps the two
 *     well-known documents where RFC 9728/8414 clients look. Get this wrong
 *     and discovery 404s in a way that reads as "this server has no OAuth".
 *  2. **PKCE is mandatory.** The refusal has to survive the global
 *     ValidationPipe (`forbidNonWhitelisted` would otherwise 400 unknown OAuth
 *     parameters with the wrong envelope) and come back as an OAuth error.
 *  3. **A wrong-audience token is refused at the MCP door**, with the RFC 6750
 *     challenge that points a client back at (1).
 *  4. **CIMD refuses a document that does not claim its own URL** — the check
 *     that stops one client impersonating another.
 *
 * `PUBLIC_BASE_URL` is set before boot because the issuer is deliberately NOT
 * derived from the Host header (see `mcpOAuthIssuer`).
 */
const BASE = 'https://jeeta.e2e.example';
const CANONICAL_RESOURCE = `${BASE}/api/mcp`;

describe('MCP OAuth authorization server (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    process.env.PUBLIC_BASE_URL = BASE;
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    delete process.env.PUBLIC_BASE_URL;
    await closeTestApp(app);
  });

  beforeEach(() => {
    safeFetchMock.mockReset();
    ctx.prisma.mcpOAuthClient.findUnique.mockResolvedValue(null as never);
    ctx.prisma.mcpOAuthClient.upsert.mockImplementation((async (args: any) => ({
      clientId: args.where.clientId,
      ...args.create,
    })) as never);
    ctx.prisma.mcpOAuthToken.findFirst.mockResolvedValue(null as never);
  });

  describe('discovery metadata (RFC 9728 / RFC 8414)', () => {
    it('publishes protected-resource metadata at the root, naming /api/mcp as the resource', async () => {
      const res = await request(app.getHttpServer()).get(
        '/.well-known/oauth-protected-resource/api/mcp',
      );

      expect(res.status).toBe(200);
      expect(res.body.resource).toBe(CANONICAL_RESOURCE);
      expect(res.body.authorization_servers).toEqual([BASE]);
      expect(res.body.bearer_methods_supported).toEqual(['header']);
      // Granular, not the legacy coarse read/write pair.
      expect(res.body.scopes_supported).toEqual(expect.arrayContaining(['leads.read', 'campaigns.send']));
      expect(res.body.scopes_supported).not.toContain('read');
    });

    it('publishes authorization-server metadata at the root with mandatory-PKCE + CIMD signalling', async () => {
      const res = await request(app.getHttpServer()).get('/.well-known/oauth-authorization-server');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
        expect.objectContaining({
          issuer: BASE,
          authorization_endpoint: `${BASE}/api/mcp-oauth/authorize`,
          token_endpoint: `${BASE}/api/mcp-oauth/token`,
          response_types_supported: ['code'],
          // S256 ONLY — advertising `plain` would tell clients PKCE is optional.
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        }),
      );
      expect(res.body.grant_types_supported).toEqual(
        expect.arrayContaining(['authorization_code', 'refresh_token']),
      );
    });

    it('does NOT serve either document under the api prefix (where no client looks)', async () => {
      await request(app.getHttpServer())
        .get('/api/.well-known/oauth-protected-resource/api/mcp')
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/.well-known/oauth-authorization-server')
        .expect(404);
    });
  });

  describe('/api/mcp-oauth/authorize', () => {
    const params = (over: Record<string, string> = {}) => ({
      response_type: 'code',
      client_id: 'https://client.e2e.example/mcp.json',
      redirect_uri: 'https://client.e2e.example/callback',
      resource: CANONICAL_RESOURCE,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      ...over,
    });

    it('refuses a request with no code_challenge (PKCE is mandatory)', async () => {
      const { code_challenge: _drop, ...withoutPkce } = params();
      const res = await request(app.getHttpServer())
        .get('/api/mcp-oauth/authorize')
        .query(withoutPkce);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toMatch(/code_challenge/i);
    });

    it('refuses code_challenge_method=plain (RFC 7636 §4.3 would otherwise default to it)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/mcp-oauth/authorize')
        .query(params({ code_challenge_method: 'plain' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toMatch(/S256/);
    });

    it('refuses a resource that is not our canonical MCP endpoint (RFC 8707)', async () => {
      // CIMD resolves fine here; the audience check is what must reject.
      safeFetchMock.mockResolvedValue(cimdResponse('https://client.e2e.example/mcp.json') as never);

      const res = await request(app.getHttpServer())
        .get('/api/mcp-oauth/authorize')
        .query(params({ resource: 'https://someone-else.example/api/mcp' }));

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_target');
    });

    it('refuses a CIMD document whose client_id is not the URL it was fetched from', async () => {
      // The impersonation check: anyone can serve a document, but only the
      // owner of the URL can serve one that names that URL.
      safeFetchMock.mockResolvedValue(cimdResponse('https://claude.ai/api/mcp/client') as never);

      const res = await request(app.getHttpServer()).get('/api/mcp-oauth/authorize').query(params());

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
      expect(res.body.error_description).toMatch(/does not claim the URL/i);
    });

    it('requires a session on the consent endpoints (the code is bound to a real human)', async () => {
      await request(app.getHttpServer())
        .get('/api/mcp-oauth/authorize/consent')
        .query(params())
        .expect(401);
      await request(app.getHttpServer())
        .post('/api/mcp-oauth/authorize/consent')
        .send({ ...params(), workspace_id: 'ws-1', granted_scopes: ['leads.read'] })
        .expect(401);
    });
  });

  describe('/api/mcp — token audience (RFC 8707)', () => {
    const token = 'mcp_at_e2e-access-token';

    /** A live, unrevoked ACCESS token row — only its `resource` varies. */
    const tokenRow = (resource: string) => ({
      id: 'tok-1',
      tokenHash: sha256Hex(token),
      type: 'ACCESS',
      clientId: 'https://client.e2e.example/mcp.json',
      workspaceId: 'ws-1',
      userId: 'mu-1',
      scopes: ['leads.read'],
      resource,
      expiresAt: new Date(Date.now() + 3_600_000),
      revokedAt: null,
      parentId: null,
      createdAt: new Date(),
    });

    it('rejects a valid token minted for ANOTHER resource server', async () => {
      ctx.prisma.mcpOAuthToken.findFirst.mockResolvedValue(
        tokenRow('https://someone-else.example/api/mcp') as never,
      );

      const res = await request(app.getHttpServer())
        .post('/api/mcp')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_token');
      // The challenge is where discovery restarts — without the pointer the
      // client cannot find the authorization server on its own.
      expect(res.headers['www-authenticate']).toContain(
        `resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`,
      );
    });

    it('accepts the same token once its audience is ours', async () => {
      ctx.prisma.mcpOAuthToken.findFirst.mockResolvedValue(tokenRow(CANONICAL_RESOURCE) as never);
      // The invoker resolves the consenting user's CURRENT role (Task 8).
      ctx.prisma.workspaceMembership.findFirst.mockResolvedValue({
        id: 'm-1',
        workspaceId: 'ws-1',
        role: 'MANAGER',
        customRoleId: null,
      } as never);

      // The documented smoke test, run for real: initialize, then tools/list.
      const init = await request(app.getHttpServer())
        .post('/api/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'e2e', version: '1.0.0' },
          },
        });

      expect(init.status).toBe(200);
      expect(init.headers['www-authenticate']).toBeUndefined();
      expect(jsonRpcResult(init).serverInfo).toMatchObject({ name: 'jeeta' });

      const list = await request(app.getHttpServer())
        .post('/api/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-session-id', init.headers['mcp-session-id'] ?? '')
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

      expect(list.status).toBe(200);
      const names = (jsonRpcResult(list).tools as Array<{ name: string }>).map((t) => t.name);
      // Scope-filtered: the token carries leads.read and nothing else, so a
      // caller cannot even SEE what it may not use.
      //
      // Asserted as the PROPERTY — every offered tool is satisfiable by the
      // granted scopes — rather than as a frozen list. The catalogue grows every
      // wave (Faz 5 D1 added leads.read-scoped pipeline tools), and a hardcoded
      // list failed CI for a legitimate addition instead of a regression, which
      // trains people to edit the assertion rather than read it.
      const registry = app.get(McpToolRegistry);
      expect(names).toContain('jeeta.search_leads');
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const tool = registry.get(name);
        expect(tool).toBeDefined();
        // every scope the tool demands must be one the token actually granted
        expect(tool!.scopes.every((s) => s === 'leads.read')).toBe(true);
      }
      // and a tool needing a scope this token lacks is genuinely absent
      expect(names).not.toContain('jeeta.list_conversations');

      // The discovery pair must be visible to EVERY caller, over real HTTP.
      // `find_tools` is how a deferred tool is found and `call_tool` is how it
      // is then run — and a client can only call names that came back from
      // THIS response, which is exactly why advertising the dispatcher is not
      // optional. Neither declares scopes, so a token holding only leads.read
      // still sees both.
      expect(names).toContain('jeeta.find_tools');
      expect(names).toContain('jeeta.call_tool');
    });

    it('challenges an unauthenticated MCP call with the discovery pointer', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer /);
      expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    });
  });
});

/**
 * The `result` of a JSON-RPC reply. Streamable HTTP may answer either as plain
 * JSON or as a one-event SSE stream depending on the negotiated Accept, so read
 * whichever arrived rather than assuming.
 */
function jsonRpcResult(res: request.Response): Record<string, unknown> {
  if (res.body && typeof res.body === 'object' && 'result' in res.body) {
    return (res.body as { result: Record<string, unknown> }).result;
  }
  const text = res.text ?? '';
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  if (!line) throw new Error(`no JSON-RPC payload in response: ${text.slice(0, 200)}`);
  return JSON.parse(line.slice('data: '.length)).result;
}

/** A CIMD document claiming `claimedClientId`, served as a fetch Response. */
function cimdResponse(claimedClientId: string) {
  const body = JSON.stringify({
    client_id: claimedClientId,
    client_name: 'E2E Client',
    redirect_uris: ['https://client.e2e.example/callback'],
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => body,
  };
}
