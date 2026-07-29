import { McpOAuthAuthorizeController } from './mcp-oauth-authorize.controller';
import { OAuthHttpException } from './mcp-oauth.errors';

const BASE = 'https://jeeta.example.com';
const CLIENT_ID = 'https://claude.ai/mcp/client-metadata.json';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const VALIDATED = {
  client: { clientId: CLIENT_ID, clientName: 'Claude', redirectUris: [REDIRECT], metadata: null },
  clientId: CLIENT_ID,
  redirectUri: REDIRECT,
  requestedScopes: ['leads.read'],
  resource: `${BASE}/api/mcp`,
  codeChallenge: 'chal',
  state: 'st-1',
};

function make() {
  const codes = {
    validate: jest.fn().mockResolvedValue(VALIDATED),
    consentData: jest.fn().mockResolvedValue({ client: {}, requestedScopes: [], workspaces: [] }),
    grant: jest.fn().mockResolvedValue({ code: 'raw-code', redirectTo: `${REDIRECT}?code=raw-code` }),
  };
  const config = { get: (k: string) => (k === 'PUBLIC_BASE_URL' ? BASE : undefined) };
  return { controller: new McpOAuthAuthorizeController(codes as any, config as any), codes };
}

function query(overrides: Record<string, unknown> = {}) {
  return {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: 'chal',
    code_challenge_method: 'S256',
    resource: `${BASE}/api/mcp`,
    scope: 'leads.read',
    state: 'st-1',
    ...overrides,
  };
}

const USER = { id: 'user-1', workspaceId: 'ws-1' } as any;

describe('McpOAuthAuthorizeController', () => {
  describe('GET /api/mcp-oauth/authorize (the browser entry point)', () => {
    it('validates the request BEFORE sending the browser anywhere', async () => {
      const { controller, codes } = make();
      const res = { redirect: jest.fn() } as any;
      await controller.authorize(query(), res);
      expect(codes.validate).toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalledTimes(1);
    });

    it('hands the browser to the consent screen, preserving the request', async () => {
      const { controller } = make();
      const res = { redirect: jest.fn() } as any;
      await controller.authorize(query(), res);

      const url = new URL(res.redirect.mock.calls[0][0]);
      expect(url.origin).toBe(BASE);
      // The consent page lives behind the app's own login, which is what turns
      // "not signed in" into a login prompt without this endpoint knowing how.
      expect(url.pathname).toBe('/oauth/consent');
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('state')).toBe('st-1');
    });

    it('never mints a code', async () => {
      const { controller, codes } = make();
      await controller.authorize(query(), { redirect: jest.fn() } as any);
      expect(codes.grant).not.toHaveBeenCalled();
    });

    it('surfaces a rejected request as an OAuth error instead of redirecting', async () => {
      const { controller, codes } = make();
      codes.validate.mockRejectedValue(new OAuthHttpException('invalid_request', 'no pkce'));
      const res = { redirect: jest.fn() } as any;
      // The redirect_uri has NOT been validated at this point, so bouncing the
      // error back to it would be an open redirect.
      await expect(controller.authorize(query(), res)).rejects.toBeInstanceOf(OAuthHttpException);
      expect(res.redirect).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/mcp-oauth/authorize/consent (the signed-in consent payload)', () => {
    it('returns what the consent screen needs and mints nothing', async () => {
      const { controller, codes } = make();
      codes.consentData.mockResolvedValue({
        client: { clientId: CLIENT_ID, clientName: 'Claude', logoUri: null },
        requestedScopes: ['leads.read'],
        resource: `${BASE}/api/mcp`,
        redirectUri: REDIRECT,
        state: 'st-1',
        workspaces: [{ workspaceId: 'ws-1', workspaceName: 'Acme', role: 'OWNER', grantableScopes: ['leads.read'] }],
      });
      const out = await controller.consentData(query(), USER);
      expect(out.client.clientName).toBe('Claude');
      expect(out.workspaces).toHaveLength(1);
      expect(codes.grant).not.toHaveBeenCalled();
      expect(codes.consentData).toHaveBeenCalledWith(VALIDATED, 'user-1');
    });
  });

  describe('POST /api/mcp-oauth/authorize/consent', () => {
    it('mints the code for the SIGNED-IN caller and returns the redirect', async () => {
      const { controller, codes } = make();
      const out = await controller.consent(
        { ...query(), workspace_id: 'ws-1', granted_scopes: ['leads.read'] },
        USER,
      );
      expect(codes.grant).toHaveBeenCalledWith(VALIDATED, 'user-1', {
        workspaceId: 'ws-1',
        scopes: ['leads.read'],
      });
      expect(out).toEqual({ redirect_to: `${REDIRECT}?code=raw-code` });
    });

    it('re-validates the request on the POST — the GET’s verdict is not trusted', async () => {
      const { controller, codes } = make();
      codes.validate.mockRejectedValue(new OAuthHttpException('invalid_target', 'bad audience'));
      // Everything in the body is attacker-controlled; a client could POST a
      // redirect_uri/resource that never passed the GET.
      await expect(
        controller.consent({ ...query(), workspace_id: 'ws-1', granted_scopes: ['leads.read'] }, USER),
      ).rejects.toBeInstanceOf(OAuthHttpException);
      expect(codes.grant).not.toHaveBeenCalled();
    });

    it('rejects a consent body with no workspace', async () => {
      const { controller } = make();
      await expect(
        controller.consent({ ...query(), granted_scopes: ['leads.read'] }, USER),
      ).rejects.toBeInstanceOf(OAuthHttpException);
    });

    it('rejects a granted_scopes that is not a string array', async () => {
      const { controller } = make();
      await expect(
        controller.consent({ ...query(), workspace_id: 'ws-1', granted_scopes: 'leads.read' }, USER),
      ).rejects.toBeInstanceOf(OAuthHttpException);
    });
  });
});
