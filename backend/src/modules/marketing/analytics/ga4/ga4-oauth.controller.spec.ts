import { NotFoundException } from '@nestjs/common';
import { Ga4EnabledGuard, Ga4PublicController, ga4CallbackReason } from './ga4-oauth.controller';

describe('GA4 OAuth routes', () => {
  const saved = process.env.GA4_SYNC_ENABLED;
  afterAll(() => {
    if (saved === undefined) delete process.env.GA4_SYNC_ENABLED;
    else process.env.GA4_SYNC_ENABLED = saved;
  });

  it('404 on every GA4 route while GA4_SYNC_ENABLED is off', () => {
    process.env.GA4_SYNC_ENABLED = 'false';
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ method: 'GET', originalUrl: '/api/marketing/integrations/ga4/connect' }) }),
    };
    expect(() => new Ga4EnabledGuard().canActivate(ctx as never)).toThrow(NotFoundException);
    process.env.GA4_SYNC_ENABLED = 'true';
    expect(new Ga4EnabledGuard().canActivate(ctx as never)).toBe(true);
  });

  const res = () => ({ redirect: jest.fn() });

  it('callback success → 302 to the Integrations tab with ga4=connected', async () => {
    const oauth = {
      handleCallback: jest.fn().mockResolvedValue({ workspaceId: 'ws-1' }),
      panelUrl: (p: string) => `https://jeetagrowth.com${p}`,
    };
    const r = res();
    await new Ga4PublicController(oauth as never).callback('state', 'code', undefined as never, r as never);
    expect(oauth.handleCallback).toHaveBeenCalledWith('state', 'code');
    expect(r.redirect).toHaveBeenCalledWith(302, 'https://jeetagrowth.com/settings/connections?ga4=connected');
  });

  it('callback failure → 302 with a coarse reason, never the message', async () => {
    const oauth = {
      handleCallback: jest.fn().mockRejectedValue(new Error('GA4 code exchange failed: redirect_uri_mismatch')),
      panelUrl: (p: string) => p,
    };
    const r = res();
    await new Ga4PublicController(oauth as never).callback('state', 'code', undefined as never, r as never);
    expect(r.redirect).toHaveBeenCalledWith(302, '/settings/connections?ga4=error&reason=exchange_redirect_uri_mismatch');
  });

  it('callback where the user declined consent → reason access_denied, no exchange attempted', async () => {
    const oauth = { handleCallback: jest.fn(), panelUrl: (p: string) => p };
    const r = res();
    await new Ga4PublicController(oauth as never).callback('state', undefined as never, 'access_denied', r as never);
    expect(oauth.handleCallback).not.toHaveBeenCalled();
    expect(r.redirect).toHaveBeenCalledWith(302, '/settings/connections?ga4=error&reason=access_denied');
  });

  it.each([
    ['Invalid or expired OAuth state', 'state_invalid'],
    ['Missing authorization code', 'missing_code'],
    ['Google did not return a refresh token (re-consent with offline access)', 'no_refresh_token'],
    ['GA4 is not configured', 'not_configured'],
    ['something else', 'failed'],
  ])('maps %p → %p', (message, reason) => {
    expect(ga4CallbackReason(message)).toBe(reason);
  });
});
