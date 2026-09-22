import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, closeTestApp, TestApp } from '../utils/test-app';
import { signLeadUnsubscribeToken } from '../../src/modules/marketing/channels/lead-unsubscribe.token';

/**
 * The unsubscribe surface, through the real request pipeline (DB seam mocked).
 *
 * This is the one public surface where a bug is a compliance breach rather than
 * a defect: a GET that opts out unsubscribes people who never clicked (mail
 * security scanners prefetch every link), a POST that swallows its error tells
 * Gmail an opt-out succeeded that was never written, and a footer link that
 * resolves to "Link expired" is an unsubscribe request that visibly does
 * nothing. Each of those is pinned below.
 */
describe('Unsubscribe (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;
  const WS = 'ws-1';
  const OLD_KEY = process.env.MARKETING_SECRET_KEY;

  beforeAll(async () => {
    // The lead-token branch is keyed off this; without it the token module
    // (correctly) refuses to mint or verify anything.
    process.env.MARKETING_SECRET_KEY = Buffer.from('e2e-unsubscribe-master-key').toString('base64');
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(async () => {
    await closeTestApp(app);
    if (OLD_KEY === undefined) delete process.env.MARKETING_SECRET_KEY;
    else process.env.MARKETING_SECRET_KEY = OLD_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Interactive transactions run their callback against the same mock.
    (ctx.prisma.$transaction as jest.Mock).mockImplementation((fn: any) =>
      typeof fn === 'function' ? fn(ctx.prisma) : Promise.resolve([]),
    );
    (ctx.prisma.lead.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (ctx.prisma.campaignRecipient.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (ctx.prisma.workspace.findUnique as jest.Mock).mockResolvedValue({ defaultLanguage: 'en' });
  });

  const recipient = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    workspaceId: WS,
    campaignId: 'c1',
    leadId: 'lead-1',
    token: 'cr_tok',
    status: 'SENT',
    channel: 'EMAIL',
    ...over,
  });

  /** The address-level projection: one pending lead, then the loop is done. */
  const onePendingLead = () => {
    (ctx.prisma.lead.findFirst as jest.Mock).mockResolvedValue({ email: 'a@b.com', emailNormalized: 'a@b.com' });
    (ctx.prisma.lead.findMany as jest.Mock).mockResolvedValueOnce([{ id: 'lead-1' }]);
  };

  it('GET is a confirm page with NO side effect (a link scanner must not opt anyone out)', async () => {
    (ctx.prisma.campaignRecipient.findUnique as jest.Mock).mockResolvedValue(recipient());

    const res = await request(app.getHttpServer()).get('/api/public/u/cr_tok');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="POST" action="/api/public/u/cr_tok">');
    expect(ctx.prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(ctx.prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
  });

  it('POST opts out, and a second POST is idempotent', async () => {
    (ctx.prisma.campaignRecipient.findUnique as jest.Mock).mockResolvedValue(recipient());
    onePendingLead();

    const first = await request(app.getHttpServer()).post('/api/public/u/cr_tok');
    // Nest's own default for a POST handler (201); what matters is that it is a
    // 2xx, which is what an RFC 8058 One-Click client reads as "done".
    expect(first.status).toBeLessThan(300);
    expect(first.text).toContain('unsubscribed');
    expect(ctx.prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { emailOptOut: true } }),
    );
    expect(ctx.prisma.consentRecord.createMany).toHaveBeenCalledTimes(1);

    // The provider redelivers (One-Click POSTs are retried): the row is already
    // UNSUBSCRIBED and no lead is left to flip, so nothing is written twice.
    jest.clearAllMocks();
    (ctx.prisma.$transaction as jest.Mock).mockImplementation((fn: any) => fn(ctx.prisma));
    (ctx.prisma.campaignRecipient.findUnique as jest.Mock).mockResolvedValue(recipient({ status: 'UNSUBSCRIBED' }));
    (ctx.prisma.lead.findFirst as jest.Mock).mockResolvedValue({ email: 'a@b.com', emailNormalized: 'a@b.com' });
    (ctx.prisma.lead.findMany as jest.Mock).mockResolvedValue([]); // nothing pending

    const second = await request(app.getHttpServer()).post('/api/public/u/cr_tok');
    expect(second.status).toBeLessThan(300);
    expect(second.text).toContain('unsubscribed');
    expect(ctx.prisma.consentRecord.createMany).not.toHaveBeenCalled();
    // No second counter bump either.
    expect(ctx.prisma.campaignRecipient.updateMany).not.toHaveBeenCalled();
  });

  it('a recipient whose campaign was deleted flips emailOptOut, never waOptOut', async () => {
    // A legacy row (no frozen channel) whose campaign is gone.
    (ctx.prisma.campaignRecipient.findUnique as jest.Mock).mockResolvedValue(recipient({ channel: null }));
    (ctx.prisma.campaign.findFirst as jest.Mock).mockResolvedValue(null);
    onePendingLead();

    const res = await request(app.getHttpServer()).post('/api/public/u/cr_tok');

    expect(res.status).toBeLessThan(300);
    const flips = (ctx.prisma.lead.updateMany as jest.Mock).mock.calls.map((c) => c[0].data);
    expect(flips).toContainEqual({ emailOptOut: true });
    expect(JSON.stringify(flips)).not.toContain('waOptOut');
  });

  it('a lead-scoped token unsubscribes with no CampaignRecipient row at all', async () => {
    (ctx.prisma.campaignRecipient.findUnique as jest.Mock).mockResolvedValue(null);
    onePendingLead();
    const token = signLeadUnsubscribeToken(WS, 'lead-9')!;

    const page = await request(app.getHttpServer()).get(`/api/public/ul/${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`action="/api/public/ul/${token}"`);

    const res = await request(app.getHttpServer()).post(`/api/public/ul/${token}`);
    expect(res.status).toBeLessThan(300);
    expect(res.text).toContain('unsubscribed');
    expect(ctx.prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { emailOptOut: true } }),
    );
  });

  it('an unknown token is "link expired" with a 200 — not our failure to retry', async () => {
    (ctx.prisma.campaignRecipient.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await request(app.getHttpServer()).post('/api/public/u/cr_nope');

    expect(res.status).toBeLessThan(300);
    expect(res.text.toLowerCase()).toContain('expired');
  });

  it('a database failure answers 5xx so the provider redelivers, and never claims success', async () => {
    (ctx.prisma.campaignRecipient.findUnique as jest.Mock).mockRejectedValue(new Error('db down'));

    const res = await request(app.getHttpServer()).post('/api/public/u/cr_tok');

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.text.toLowerCase()).not.toContain('you have been unsubscribed');
  });
});
