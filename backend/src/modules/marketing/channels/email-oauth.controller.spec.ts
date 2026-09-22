import type { Request, Response } from 'express';
import { emailOAuthRedirectUri } from './email-oauth.config';
import { EMAIL_OAUTH_BIND_COOKIE, EmailOAuthController } from './email-oauth.controller';

/**
 * The consent round-trip, from the browser's side.
 *
 * A signed `state` proves the link was minted by this server. It does NOT
 * prove it was minted FOR the person who is now consenting — and that gap is
 * the whole attack: workspace X starts a connect, forwards the authorize URL
 * to a target, and the target's consent (their mailbox, their tokens) lands on
 * X's channel. The cookie set at `start` is what makes the state belong to one
 * browser, and clearing it at the callback is what makes it single-use.
 */
describe('mailbox consent, bound to the browser that started it', () => {
  let svc: any;
  let ctrl: EmailOAuthController;
  let res: any;

  const reqWith = (cookie?: string): Request =>
    ({ headers: cookie ? { cookie } : {} }) as unknown as Request;

  beforeEach(() => {
    svc = {
      start: jest.fn(() => ({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=st-1', state: 'st-1' })),
      handleCallback: jest.fn().mockResolvedValue({ channelId: 'ch-1', address: 'a@b.test' }),
      providers: jest.fn(() => []),
      suggestSmtpFor: jest.fn(),
    };
    ctrl = new EmailOAuthController(svc);
    res = { cookie: jest.fn(), clearCookie: jest.fn(), redirect: jest.fn() };
    process.env.FRONTEND_URL = 'https://app.example.com';
  });

  afterEach(() => {
    delete process.env.FRONTEND_URL;
  });

  /** The value `start` put in the browser, as the browser would send it back. */
  const bindCookieHeader = (): string => {
    const [name, value] = res.cookie.mock.calls[0];
    return `${name}=${value}`;
  };

  const start = () =>
    ctrl.start({ provider: 'GOOGLE' }, { workspaceId: 'ws-1' } as any, res as Response);

  describe('start', () => {
    it('binds the state to this browser and keeps it out of the response body', () => {
      const body = start();

      expect(body).toEqual({ authorizeUrl: expect.stringContaining('accounts.google.com') });
      expect((body as any).state).toBeUndefined();
      const [name, value, opts] = res.cookie.mock.calls[0];
      expect(name).toBe(EMAIL_OAUTH_BIND_COOKIE);
      // A hash, not the state: the cookie stays small and the signed,
      // workspace-bearing token is not written to a second place.
      expect(value).not.toContain('st-1');
      expect(opts).toMatchObject({
        httpOnly: true,
        // Lax, never Strict: the callback is a cross-site top-level GET from
        // the provider, and Strict would drop the cookie on every real connect.
        sameSite: 'lax',
        path: '/api/marketing/channels/email/oauth',
      });
      expect(opts.maxAge).toBeGreaterThan(0);
    });

    it('scopes the cookie to a path the callback actually lives under', () => {
      // A cookie the browser does not send with the callback is a connect that
      // always fails, so this pins the one relationship the two ends share:
      // move the route, and the path here has to move with it.
      process.env.PUBLIC_BASE_URL = 'https://app.example.com';
      start();
      const path = res.cookie.mock.calls[0][2].path;
      expect(new URL(emailOAuthRedirectUri()).pathname.startsWith(path)).toBe(true);
      delete process.env.PUBLIC_BASE_URL;
    });
  });

  describe('callback', () => {
    it('completes the connection when the state matches this browser', async () => {
      start();
      await ctrl.callback('code', 'st-1', '', reqWith(bindCookieHeader()), res as Response);

      expect(svc.handleCallback).toHaveBeenCalledWith('code', 'st-1');
      expect(res.redirect).toHaveBeenLastCalledWith(302, 'https://app.example.com/accounts?email_connected=1');
    });

    it('refuses a consent link that was forwarded to someone else', async () => {
      // The target's browser never visited `start`, so it carries no binding
      // cookie — and a signed state alone must not be enough.
      await ctrl.callback('code', 'st-1', '', reqWith(undefined), res as Response);

      expect(svc.handleCallback).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenLastCalledWith(302, 'https://app.example.com/accounts?connect_error=1');
    });

    it('refuses a state that does not match the cookie it was minted with', async () => {
      start();
      await ctrl.callback('code', 'another-state', '', reqWith(bindCookieHeader()), res as Response);

      expect(svc.handleCallback).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenLastCalledWith(302, 'https://app.example.com/accounts?connect_error=1');
    });

    it('spends the binding once: the same code and state replayed are refused', async () => {
      start();
      const cookie = bindCookieHeader();
      await ctrl.callback('code', 'st-1', '', reqWith(cookie), res as Response);

      // The clear is what makes it single-use — the browser stops sending it.
      expect(res.clearCookie).toHaveBeenCalledWith(EMAIL_OAUTH_BIND_COOKIE, {
        path: '/api/marketing/channels/email/oauth',
      });

      svc.handleCallback.mockClear();
      await ctrl.callback('code', 'st-1', '', reqWith(undefined), res as Response);
      expect(svc.handleCallback).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenLastCalledWith(302, 'https://app.example.com/accounts?connect_error=1');
    });

    it('still refuses the provider error path before looking at anything else', async () => {
      await ctrl.callback('', '', 'access_denied', reqWith(undefined), res as Response);
      expect(svc.handleCallback).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenLastCalledWith(302, 'https://app.example.com/accounts?connect_error=1');
    });

    it('sends the owner back to one error page when the exchange fails', async () => {
      start();
      svc.handleCallback.mockRejectedValue(new Error('token exchange refused'));
      await ctrl.callback('code', 'st-1', '', reqWith(bindCookieHeader()), res as Response);
      expect(res.redirect).toHaveBeenLastCalledWith(302, 'https://app.example.com/accounts?connect_error=1');
    });
  });
});
