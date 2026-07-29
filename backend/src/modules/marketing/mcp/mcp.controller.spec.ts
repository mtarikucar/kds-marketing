import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { McpController } from './mcp.controller';

const BASE = 'https://jeeta.example.com';
/** RFC 9728 §3 — the resource path is a SUFFIX of the well-known path. */
const METADATA_URL = `${BASE}/.well-known/oauth-protected-resource/api/mcp`;

function fakeRes() {
  return { status: jest.fn().mockReturnThis(), setHeader: jest.fn(), json: jest.fn(), end: jest.fn(), once: jest.fn() } as any;
}

/** `opts.baseUrl` is only omitted to model an unconfigured deployment. */
function makeController(factory: any, verifier: any, opts: { baseUrl?: string } = { baseUrl: BASE }) {
  const config = { get: (k: string) => (k === 'PUBLIC_BASE_URL' ? opts.baseUrl : undefined) } as any;
  return new McpController(factory, verifier, config);
}

/** The `WWW-Authenticate` value the controller set, or undefined. */
function challenge(res: any): string | undefined {
  const call = res.setHeader.mock.calls.find(([name]: [string]) => name === 'WWW-Authenticate');
  return call?.[1];
}

describe('McpController', () => {
  it('rejects a request with no bearer token', async () => {
    const factory = { build: jest.fn() } as any;
    const verifier = { verifyAccessToken: jest.fn() } as any;
    const controller = makeController(factory, verifier);
    const res = fakeRes();
    await controller.handle({ headers: {}, method: 'POST', body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
    // RFC 6750 §3.1: no credential was supplied at all, so the challenge
    // carries no `error`/`error_description` — those are reserved for a
    // credential that WAS supplied and rejected.
    expect(challenge(res)).not.toContain('error=');
  });

  it('rejects an invalid bearer token without building a server', async () => {
    const factory = { build: jest.fn() } as any;
    // The real McpTokenVerifierService rejects with an OAuthError (see
    // mcp-token-verifier.service.ts); mirror that here rather than a bare
    // Error so this test exercises the actual contract between the two.
    const verifier = {
      verifyAccessToken: jest.fn().mockRejectedValue(new OAuthError(OAuthErrorCode.InvalidToken, 'bad')),
    } as any;
    const controller = makeController(factory, verifier);
    const res = fakeRes();
    await controller.handle({ headers: { authorization: 'Bearer nope' }, method: 'POST', body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(factory.build).not.toHaveBeenCalled();
    // A credential WAS supplied here, so — unlike the missing-token case —
    // the challenge DOES carry error="invalid_token".
    expect(challenge(res)).toContain('error="invalid_token"');
  });

  it('re-throws a non-OAuthError from token verification instead of reporting a 401', async () => {
    // A database outage (or any other real failure) is not "your key is
    // bad" — telling the caller to re-mint a key that was never the problem
    // would hide the actual failure, so it must propagate, not become 401.
    const factory = { build: jest.fn() } as any;
    const verifier = { verifyAccessToken: jest.fn().mockRejectedValue(new Error('db is down')) } as any;
    const controller = makeController(factory, verifier);
    const res = fakeRes();
    await expect(
      controller.handle({ headers: { authorization: 'Bearer whatever' }, method: 'POST', body: {} } as any, res),
    ).rejects.toThrow('db is down');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('forwards the verified AuthInfo (and the pre-parsed body) to the handler', async () => {
    const factory = { build: jest.fn() } as any;
    const authInfo: AuthInfo = {
      token: 'mk_live_good',
      clientId: 'key_1',
      scopes: ['reports.read'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { workspaceId: 'ws_1', apiKeyId: 'key_1' },
    };
    const verifier = { verifyAccessToken: jest.fn().mockResolvedValue(authInfo) } as any;
    const controller = makeController(factory, verifier);

    // The controller builds its own `handler` from the real SDK in its
    // constructor; swap it for a stub so this test pins only the
    // controller's own auth-wiring, not the SDK's internal request routing.
    const fetchMock = jest.fn().mockResolvedValue(new Response(null, { status: 200 }));
    (controller as any).handler = { fetch: fetchMock };

    const body = { jsonrpc: '2.0', method: 'tools/list', id: 1 };
    const req: any = {
      headers: { authorization: 'Bearer mk_live_good' },
      method: 'POST',
      body,
      protocol: 'http',
      get: () => 'localhost:3000',
      originalUrl: '/api/mcp',
    };
    const res = fakeRes();

    await controller.handle(req, res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(options).toEqual({ authInfo, parsedBody: body });
  });

  /**
   * RFC 9728 §5.1 — discovery starts from the 401. Without `resource_metadata`
   * an MCP client that has never seen this server has no way to find the
   * authorization server, and the connector flow cannot start at all.
   */
  describe('RFC 9728 discovery challenges', () => {
    it('points an unauthenticated caller at the protected-resource metadata', async () => {
      const controller = makeController({ build: jest.fn() }, { verifyAccessToken: jest.fn() });
      const res = fakeRes();
      await controller.handle({ headers: {}, method: 'POST', body: {} } as any, res);
      expect(challenge(res)).toContain(`resource_metadata="${METADATA_URL}"`);
    });

    it('points a rejected caller at it too', async () => {
      const verifier = {
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new OAuthError(OAuthErrorCode.InvalidToken, 'expired')),
      } as any;
      const controller = makeController({ build: jest.fn() }, verifier);
      const res = fakeRes();
      await controller.handle({ headers: { authorization: 'Bearer x' }, method: 'POST', body: {} } as any, res);
      expect(challenge(res)).toContain(`resource_metadata="${METADATA_URL}"`);
    });

    it('still answers 401 when PUBLIC_BASE_URL is unset, just without the hint', async () => {
      // A misconfigured deployment must not turn an auth failure into a 500.
      const controller = makeController({ build: jest.fn() }, { verifyAccessToken: jest.fn() }, {});
      const res = fakeRes();
      await controller.handle({ headers: {}, method: 'POST', body: {} } as any, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(challenge(res)).not.toContain('resource_metadata');
    });
  });

  describe('insufficient scope', () => {
    it('answers 403 with an insufficient_scope challenge, not 401', async () => {
      const factory = { build: jest.fn() } as any;
      const verifier = {
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new OAuthError(OAuthErrorCode.InsufficientScope, 'no mcp scopes')),
      } as any;
      const controller = makeController(factory, verifier);
      const res = fakeRes();

      await controller.handle({ headers: { authorization: 'Bearer x' }, method: 'POST', body: {} } as any, res);

      // The credential is valid — re-authenticating would change nothing. 403
      // + insufficient_scope is what tells the client to request more scope.
      expect(res.status).toHaveBeenCalledWith(403);
      expect(challenge(res)).toContain('error="insufficient_scope"');
      expect(challenge(res)).toContain(`resource_metadata="${METADATA_URL}"`);
      expect(factory.build).not.toHaveBeenCalled();
    });

    it('advertises the scopes the resource understands', async () => {
      const verifier = {
        verifyAccessToken: jest
          .fn()
          .mockRejectedValue(new OAuthError(OAuthErrorCode.InsufficientScope, 'no mcp scopes')),
      } as any;
      const controller = makeController({ build: jest.fn() }, verifier);
      const res = fakeRes();
      await controller.handle({ headers: { authorization: 'Bearer x' }, method: 'POST', body: {} } as any, res);
      expect(challenge(res)).toContain('scope="');
      expect(challenge(res)).toContain('leads.read');
    });
  });
});
