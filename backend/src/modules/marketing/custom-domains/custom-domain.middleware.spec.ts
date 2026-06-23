import { customDomainHostMiddleware } from './custom-domain.middleware';

describe('customDomainHostMiddleware', () => {
  let domains: { resolveHost: jest.Mock };
  let sites: { renderPublic: jest.Mock };
  let mw: (req: any, res: any, next: any) => Promise<void>;
  let next: jest.Mock;
  let res: any;
  const realFlag = process.env.CUSTOM_DOMAINS_ENABLED;

  beforeEach(() => {
    delete process.env.CUSTOM_DOMAINS_ENABLED;
    domains = { resolveHost: jest.fn() };
    sites = { renderPublic: jest.fn() };
    mw = customDomainHostMiddleware(domains as any, sites as any);
    next = jest.fn();
    res = { type: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() };
  });

  afterAll(() => {
    if (realFlag === undefined) delete process.env.CUSTOM_DOMAINS_ENABLED;
    else process.env.CUSTOM_DOMAINS_ENABLED = realFlag;
  });

  it('is a pure pass-through when disabled (never touches DNS/DB)', async () => {
    await mw({ path: '/', hostname: 'acme.com' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(domains.resolveHost).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  describe('when enabled', () => {
    beforeEach(() => { process.env.CUSTOM_DOMAINS_ENABLED = '1'; });

    it('never hijacks API paths', async () => {
      await mw({ path: '/api/marketing/leads', hostname: 'acme.com' }, res, next);
      expect(next).toHaveBeenCalled();
      expect(domains.resolveHost).not.toHaveBeenCalled();
    });

    it('passes through when the host is not a custom domain', async () => {
      domains.resolveHost.mockResolvedValue(null);
      await mw({ path: '/', hostname: 'marketing.platform.example' }, res, next);
      expect(next).toHaveBeenCalled();
      expect(sites.renderPublic).not.toHaveBeenCalled();
    });

    it('renders the home slug for "/" on a matched custom domain', async () => {
      domains.resolveHost.mockResolvedValue({ workspaceId: 'ws-1', homeSlug: 'home' });
      sites.renderPublic.mockResolvedValue('<html>site</html>');
      await mw({ path: '/', hostname: 'go.acme.com' }, res, next);
      expect(sites.renderPublic).toHaveBeenCalledWith('ws-1', 'home', 'https://go.acme.com');
      expect(res.send).toHaveBeenCalledWith('<html>site</html>');
      expect(next).not.toHaveBeenCalled();
    });

    it('maps a sub-path to its slug and 404s an unknown page (without falling through)', async () => {
      domains.resolveHost.mockResolvedValue({ workspaceId: 'ws-1', homeSlug: 'home' });
      sites.renderPublic.mockResolvedValue(null);
      await mw({ path: '/pricing', hostname: 'go.acme.com' }, res, next);
      expect(sites.renderPublic).toHaveBeenCalledWith('ws-1', 'pricing', 'https://go.acme.com');
      expect(res.status).toHaveBeenCalledWith(404);
      expect(next).not.toHaveBeenCalled();
    });

    it('falls through (never 500s the request) if rendering throws', async () => {
      domains.resolveHost.mockResolvedValue({ workspaceId: 'ws-1', homeSlug: 'home' });
      sites.renderPublic.mockRejectedValue(new Error('boom'));
      await mw({ path: '/', hostname: 'go.acme.com' }, res, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
