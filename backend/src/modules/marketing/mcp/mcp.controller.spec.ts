import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { McpController } from './mcp.controller';

function fakeRes() {
  return { status: jest.fn().mockReturnThis(), setHeader: jest.fn(), json: jest.fn(), end: jest.fn(), once: jest.fn() } as any;
}

describe('McpController', () => {
  it('rejects a request with no bearer token', async () => {
    const factory = { build: jest.fn() } as any;
    const verifier = { verifyAccessToken: jest.fn() } as any;
    const controller = new McpController(factory, verifier);
    const res = fakeRes();
    await controller.handle({ headers: {}, method: 'POST', body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
    // RFC 6750 §3.1: no credential was supplied at all, so the challenge
    // must be bare — no `error`/`error_description`, those are reserved for
    // a credential that WAS supplied and rejected.
    expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="jeeta-mcp"');
  });

  it('rejects an invalid bearer token without building a server', async () => {
    const factory = { build: jest.fn() } as any;
    // The real McpTokenVerifierService rejects with an OAuthError (see
    // mcp-token-verifier.service.ts); mirror that here rather than a bare
    // Error so this test exercises the actual contract between the two.
    const verifier = {
      verifyAccessToken: jest.fn().mockRejectedValue(new OAuthError(OAuthErrorCode.InvalidToken, 'bad')),
    } as any;
    const controller = new McpController(factory, verifier);
    const res = fakeRes();
    await controller.handle({ headers: { authorization: 'Bearer nope' }, method: 'POST', body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(factory.build).not.toHaveBeenCalled();
    // A credential WAS supplied here, so — unlike the missing-token case —
    // the challenge DOES carry error="invalid_token".
    expect(res.setHeader).toHaveBeenCalledWith('WWW-Authenticate', expect.stringContaining('error="invalid_token"'));
  });

  it('re-throws a non-OAuthError from token verification instead of reporting a 401', async () => {
    // A database outage (or any other real failure) is not "your key is
    // bad" — telling the caller to re-mint a key that was never the problem
    // would hide the actual failure, so it must propagate, not become 401.
    const factory = { build: jest.fn() } as any;
    const verifier = { verifyAccessToken: jest.fn().mockRejectedValue(new Error('db is down')) } as any;
    const controller = new McpController(factory, verifier);
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
    const controller = new McpController(factory, verifier);

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
});
