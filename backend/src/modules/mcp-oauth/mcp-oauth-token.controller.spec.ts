import { McpOAuthTokenController } from './mcp-oauth-token.controller';
import { OAuthHttpException } from './mcp-oauth.errors';

function make() {
  const tokens = {
    grant: jest.fn().mockResolvedValue({
      access_token: 'mcp_at_x',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'mcp_rt_y',
      scope: 'leads.read',
    }),
  };
  return { controller: new McpOAuthTokenController(tokens as any), tokens };
}

function res() {
  return { setHeader: jest.fn() } as any;
}

describe('McpOAuthTokenController', () => {
  it('returns the RFC 6749 token response verbatim', async () => {
    const { controller } = make();
    const out = await controller.token({ grant_type: 'refresh_token' }, res());
    expect(out).toEqual({
      access_token: 'mcp_at_x',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'mcp_rt_y',
      scope: 'leads.read',
    });
  });

  it('forwards the request body untouched to the grant handler', async () => {
    const { controller, tokens } = make();
    const body = { grant_type: 'authorization_code', code: 'c', code_verifier: 'v' };
    await controller.token(body, res());
    expect(tokens.grant).toHaveBeenCalledWith(body);
  });

  it('forbids caching the response (RFC 6749 §5.1)', async () => {
    const { controller } = make();
    const r = res();
    await controller.token({ grant_type: 'refresh_token' }, r);
    // The body contains bearer credentials; a shared cache holding it would
    // hand them to the next caller.
    expect(r.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(r.setHeader).toHaveBeenCalledWith('Pragma', 'no-cache');
  });

  it('lets an OAuth error through as the RFC 6749 envelope, not a Nest error', async () => {
    const { controller, tokens } = make();
    tokens.grant.mockRejectedValue(new OAuthHttpException('invalid_grant', 'code is spent'));
    await expect(controller.token({ grant_type: 'authorization_code' }, res())).rejects.toMatchObject(
      {
        // A client reads `error` to decide whether to re-run the whole flow;
        // Nest's default body would put the HTTP reason phrase there instead.
        response: { error: 'invalid_grant', error_description: 'code is spent' },
      },
    );
  });
});
