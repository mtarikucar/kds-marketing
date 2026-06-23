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
 * Epic A4 — duplicate detection + merge end to end (DB seam mocked): list
 * duplicate clusters, merge a duplicate into a canonical (tombstone), and the
 * canonical-in-duplicates guard.
 */
describe('Lead dedupe + merge (e2e)', () => {
  let ctx: TestApp;
  let app: NestExpressApplication;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = ctx.app;
  });

  afterAll(() => closeTestApp(app));

  beforeEach(() => {
    jest.clearAllMocks();
    ctx.prisma.marketingUser.findUnique.mockResolvedValue(
      mockMarketingUser() as never,
    );
  });

  const auth = () => `Bearer ${signMarketingToken({ sub: 'mu-1', wsp: 'ws-1' })}`;

  it('lists duplicate clusters by shared normalized phone', async () => {
    ctx.prisma.lead.findMany.mockResolvedValue([
      { id: 'a', phoneNormalized: '5551234', emailNormalized: null, createdAt: new Date('2026-01-01'), convertedTenantId: null, businessName: 'A' },
      { id: 'b', phoneNormalized: '5551234', emailNormalized: null, createdAt: new Date('2026-02-01'), convertedTenantId: null, businessName: 'B' },
    ] as never);

    const res = await request(app.getHttpServer())
      .get('/api/marketing/leads/duplicates')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].suggestedCanonicalId).toBe('a');
  });

  it('merges a duplicate into the canonical and tombstones it', async () => {
    ctx.prisma.lead.findMany.mockResolvedValue([
      { id: 'a', workspaceId: 'ws-1', customFields: {}, mergedIntoId: null, convertedTenantId: null, city: null },
      { id: 'b', workspaceId: 'ws-1', customFields: {}, mergedIntoId: null, convertedTenantId: null, city: 'Ankara' },
    ] as never);
    ctx.prisma.leadTag.findMany.mockResolvedValue([] as never);
    ctx.prisma.campaignRecipient.findMany.mockResolvedValue([] as never);
    // The tombstone updateMany's .count is checked against dupIds.length (TOCTOU guard);
    // without this the deep-mock returns undefined → undefined.count → 500.
    (ctx.prisma.lead.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (ctx.prisma.$transaction as jest.Mock).mockImplementation(async (fn: any) => fn(ctx.prisma));

    const res = await request(app.getHttpServer())
      .post('/api/marketing/leads/merge')
      .set('Authorization', auth())
      .send({ canonicalId: 'a', duplicateIds: ['b'] });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ canonicalId: 'a', merged: 1 });
    expect(ctx.prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // convertedTenantId:null is the TOCTOU claim — a dup converted mid-merge is not tombstoned.
        where: { id: { in: ['b'] }, workspaceId: 'ws-1', convertedTenantId: null },
        data: expect.objectContaining({ mergedIntoId: 'a' }),
      }),
    );
  });

  it('rejects merging a lead into itself (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/marketing/leads/merge')
      .set('Authorization', auth())
      .send({ canonicalId: 'a', duplicateIds: ['a'] });

    expect(res.status).toBe(400);
  });
});
