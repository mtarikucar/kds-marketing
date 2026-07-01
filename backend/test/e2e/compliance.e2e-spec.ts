import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  createTestApp,
  closeTestApp,
  TestApp,
  signMarketingToken,
  mockMarketingUser,
} from '../utils/test-app';

/**
 * Epic F (compliance) — consent + data subject requests end to end (DB seam
 * mocked): record a marketing consent (syncs opt-out), export a lead bundle,
 * request erasure (PENDING), and a REP is forbidden.
 */
describe('Compliance (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => jest.clearAllMocks());

  const ownerAuth = () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'OWNER' }) as never);
    return `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'OWNER' })}`;
  };

  it('records a marketing consent (syncs opt-out)', async () => {
    const auth = ownerAuth();
    ctx.prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as never);
    (ctx.prisma.consentRecord.create as jest.Mock).mockResolvedValue({ id: 'cr1' });
    (ctx.prisma.lead.update as jest.Mock).mockResolvedValue({});

    const res = await request(app.getHttpServer())
      .post('/api/marketing/compliance/leads/lead-1/consent')
      .set('Authorization', auth)
      .send({ type: 'MARKETING_EMAIL', granted: false });

    expect(res.status).toBe(201);
    const upd = (ctx.prisma.lead.update as jest.Mock).mock.calls[0][0];
    expect(upd.data).toEqual({ emailOptOut: true });
  });

  it('exports a lead bundle', async () => {
    const auth = ownerAuth();
    ctx.prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1', activities: [], offers: [], tasks: [] } as never);
    ctx.prisma.consentRecord.findMany.mockResolvedValue([] as never);
    // The DSAR export gathers ~26 lead-scoped categories (expanded in f4daaaa/5587a92/
    // d5583ce); the service reads conversations.length + wallets.map, so every
    // un-stubbed findMany returning undefined → 500. Stub the whole gather to empty.
    for (const m of [
      'conversation', 'booking', 'document', 'estimate', 'invoice', 'review', 'voiceCall',
      'salesCall', 'surveyResponse', 'opportunity', 'contactIdentity', 'enrollment',
      'certificate', 'communityMember', 'earnedBadge', 'customerSubscription', 'customerWallet',
      'pointsLedger', 'customObjectLink', 'triggerLinkClick', 'couponRedemption',
      'campaignRecipient', 'leadTag', 'communityPost', 'communityComment', 'walletLedgerEntry',
    ]) {
      ((ctx.prisma as any)[m].findMany as jest.Mock).mockResolvedValue([]);
    }
    (ctx.prisma.dataRequest.create as jest.Mock).mockResolvedValue({});

    const res = await request(app.getHttpServer())
      .post('/api/marketing/compliance/leads/lead-1/export')
      .set('Authorization', auth);

    expect(res.status).toBe(201);
    expect(res.body.lead.id).toBe('lead-1');
  });

  it('records an erasure request as PENDING', async () => {
    const auth = ownerAuth();
    ctx.prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as never);
    (ctx.prisma.dataRequest.create as jest.Mock).mockResolvedValue({ id: 'dr1', kind: 'ERASURE', status: 'PENDING' });

    const res = await request(app.getHttpServer())
      .post('/api/marketing/compliance/leads/lead-1/erasure')
      .set('Authorization', auth);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'PENDING' });
  });

  it('forbids a REP from compliance actions', async () => {
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(mockMarketingUser({ role: 'REP' }) as never);
    const res = await request(app.getHttpServer())
      .post('/api/marketing/compliance/leads/lead-1/export')
      .set('Authorization', `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1', role: 'REP' })}`);
    expect(res.status).toBe(403);
  });
});
