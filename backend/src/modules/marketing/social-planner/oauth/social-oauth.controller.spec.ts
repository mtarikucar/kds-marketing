import { NotFoundException } from '@nestjs/common';
import { SocialOAuthController, CONNECT_RESULT_ROUTES } from './social-oauth.controller';
import { signState } from './social-oauth-state.util';

/**
 * Where a finished consent LANDS.
 *
 * The callback appends the OAuth result to the URL (`?connect=<pendingId>`, or
 * `?connect_error=1`) and 302s the browser at the console. That only works if
 * the route it picks actually READS those params: the Account Center does
 * (AccountCenterPage), `/social` is a <Navigate> to a FIXED studio URL that
 * discards the query, and `/channels` is not a route at all. Landing on either
 * of the latter two silently abandons a connection the user already consented
 * to — the pending row expires 15 minutes later and nothing says why.
 *
 * So the assertion is not "origin X maps to path Y" but the invariant behind
 * it: every path this endpoint can possibly emit is a param-reading route.
 */
describe('SocialOAuthController — the callback lands where the result can be read', () => {
  const env = { ...process.env };
  let pendingId = 'pend-1';
  let fail = false;

  const svc = {
    handleCallback: jest.fn(async () => {
      if (fail) throw new Error('exchange failed');
      return { pendingId, workspaceId: 'ws-1' };
    }),
  };
  const controller = new SocialOAuthController(svc as any);

  const res = () => {
    const captured: { status?: number; url?: string } = {};
    return {
      captured,
      redirect: (status: number, url: string) => {
        captured.status = status;
        captured.url = url;
      },
    };
  };

  /** The path segment the browser is sent to, e.g. 'accounts'. */
  const landedOn = (url: string) => new URL(url).pathname.replace(/^\/+/, '');

  beforeEach(() => {
    jest.clearAllMocks();
    fail = false;
    pendingId = 'pend-1';
    process.env.MARKETING_SECRET_KEY = 'k'.repeat(32);
    process.env.FRONTEND_URL = 'https://console.example.com';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  // Every value StartDto accepts, plus the absent case (older links carry no
  // origin at all). None of them may strand a completed consent.
  const ORIGINS = ['social', 'channels', 'account-center', undefined] as const;

  it.each(ORIGINS)('a successful callback with origin=%s lands on a param-reading route', async (origin) => {
    const r = res();
    const state = signState({ workspaceId: 'ws-1', network: 'FACEBOOK', origin });
    await controller.callback('facebook', 'code-1', state, '', r as any);

    expect(r.captured.status).toBe(302);
    expect(CONNECT_RESULT_ROUTES).toContain(landedOn(r.captured.url!));
    expect(new URL(r.captured.url!).searchParams.get('connect')).toBe('pend-1');
  });

  it.each(ORIGINS)('a failed callback with origin=%s lands on a param-reading route', async (origin) => {
    const r = res();
    const state = signState({ workspaceId: 'ws-1', network: 'FACEBOOK', origin });
    await controller.callback('facebook', '', state, 'access_denied', r as any);

    expect(r.captured.status).toBe(302);
    expect(CONNECT_RESULT_ROUTES).toContain(landedOn(r.captured.url!));
    expect(new URL(r.captured.url!).searchParams.get('connect_error')).toBe('1');
  });

  // A provider whose exchange blows up is a real, expected failure of a real
  // network: the user gets told on a page that can tell them.
  it('a provider-side failure still redirects with connect_error', async () => {
    fail = true;
    const r = res();
    const state = signState({ workspaceId: 'ws-1', network: 'FACEBOOK', origin: 'account-center' });
    await controller.callback('facebook', 'code-1', state, '', r as any);
    expect(r.captured.status).toBe(302);
    expect(new URL(r.captured.url!).searchParams.get('connect_error')).toBe('1');
  });

  /**
   * `/oauth/zzz/callback` used to 302 to `?connect_error=1`, i.e. a route that
   * does not exist was reported to the user as "your connection failed". A
   * network we do not implement is a 404 about the URL, not a story about a
   * connection attempt that never happened.
   */
  it('an unknown network is a 404, not a generic connect error', async () => {
    const r = res();
    await expect(controller.callback('zzz', '', '', '', r as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(r.captured.status).toBeUndefined();
    expect(svc.handleCallback).not.toHaveBeenCalled();
  });

  it('rejects an unknown network before looking at the code or state', async () => {
    const r = res();
    const state = signState({ workspaceId: 'ws-1', network: 'FACEBOOK' });
    await expect(controller.callback('myspace', 'code-1', state, '', r as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
