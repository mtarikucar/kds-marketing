import { PublicAuditController } from './public-audit.controller';

describe('PublicAuditController (public token-gated render)', () => {
  let audits: { publicView: jest.Mock };
  let branding: { get: jest.Mock };
  let ctrl: PublicAuditController;

  const res = () => {
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.type = jest.fn().mockReturnValue(r);
    r.send = jest.fn().mockReturnValue(r);
    return r;
  };

  beforeEach(() => {
    audits = { publicView: jest.fn() };
    branding = { get: jest.fn().mockResolvedValue({ brandName: 'Acme', accentColor: '#123456', logoUrl: null }) };
    ctrl = new PublicAuditController(audits as any, branding as any);
  });

  it('404s an unknown/forged token (no render)', async () => {
    audits.publicView.mockRejectedValue(new Error('not found'));
    const r = res();
    await ctrl.page('bogus', r);
    expect(r.status).toHaveBeenCalledWith(404);
    expect(branding.get).not.toHaveBeenCalled();
  });

  it('renders a DONE audit as branded HTML', async () => {
    audits.publicView.mockResolvedValue({
      workspaceId: 'ws-1', businessName: 'Test Biz', targetUrl: 'https://x.example', status: 'DONE', score: 73,
      sections: [{ key: 'onpage', label: 'On-page SEO', score: 80, status: 'good', findings: ['Title present.'] }],
    });
    const r = res();
    await ctrl.page('pa_token', r);
    const html = r.send.mock.calls[0][0] as string;
    expect(html).toContain('73'); // overall score
    expect(html).toContain('On-page SEO');
    expect(html).toContain('Acme'); // workspace branding
  });

  it('escapes hostile audit content (no stored XSS via businessName/findings)', async () => {
    audits.publicView.mockResolvedValue({
      workspaceId: 'ws-1', businessName: '<script>alert(1)</script>', targetUrl: 'https://x', status: 'DONE', score: 10,
      sections: [{ key: 'k', label: '<img onerror=x>', score: 10, status: 'poor', findings: ['<b>bad</b>'] }],
    });
    const r = res();
    await ctrl.page('pa_token', r);
    const html = r.send.mock.calls[0][0] as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img onerror=');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows a pending/failed state without a score', async () => {
    audits.publicView.mockResolvedValue({ workspaceId: 'ws-1', businessName: 'B', targetUrl: 'https://x', status: 'RUNNING', score: null, sections: [] });
    const r = res();
    await ctrl.page('pa_token', r);
    const html = r.send.mock.calls[0][0] as string;
    expect(html).toMatch(/running|moment/i);
  });
});
