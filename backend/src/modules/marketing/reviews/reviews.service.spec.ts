import { ReviewsService } from './reviews.service';

/**
 * The rating gate is the heart of reputation management: ≥4 stars route the
 * customer to the public review site, <4 capture private feedback (and never
 * route public). Both emit review.received.
 */
describe('ReviewsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outbox: { append: jest.Mock };
  let anthropic: any;
  let credits: any;
  let svc: ReviewsService;

  beforeEach(() => {
    prisma = {
      reviewSource: { findFirst: jest.fn().mockResolvedValue({ id: 'src1', placeUrl: 'https://g.page/r/biz' }) },
      review: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'rev1', token: 'rv_abc' }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    outbox = { append: jest.fn().mockResolvedValue('e') };
    anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn().mockResolvedValue({ text: 'Thank you for the kind words!' }) };
    credits = { reserve: jest.fn(), refund: jest.fn() };
    const config = { get: jest.fn().mockReturnValue('https://m.example') };
    svc = new ReviewsService(prisma as any, config as any, outbox as any, anthropic as any, credits as any);
  });

  it('requestReview mints a review + returns the gate link', async () => {
    const res = await svc.requestReview(WS, 'lead-1');
    expect(res.gateUrl).toBe('https://m.example/api/public/r/rv_abc');
    expect(prisma.review.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, leadId: 'lead-1', status: 'REQUESTED' });
  });

  it('≥4 stars routes to the public source URL (PUBLIC_ROUTED)', async () => {
    prisma.review.findUnique.mockResolvedValue({ id: 'rev1', workspaceId: WS, sourceId: 'src1', leadId: 'lead-1' });
    const res = await svc.submitRating('rv_abc', 5);
    expect(res.redirectUrl).toBe('https://g.page/r/biz');
    expect(prisma.review.update.mock.calls[0][0].data.status).toBe('PUBLIC_ROUTED');
    expect(outbox.append.mock.calls[0][0].type).toBe('marketing.review.received.v1');
  });

  it('<4 stars captures private feedback, no public redirect', async () => {
    prisma.review.findUnique.mockResolvedValue({ id: 'rev1', workspaceId: WS, sourceId: 'src1', leadId: 'lead-1' });
    const res = await svc.submitRating('rv_abc', 2, 'slow service');
    expect(res.redirectUrl).toBeNull();
    const data = prisma.review.update.mock.calls[0][0].data;
    expect(data.status).toBe('PRIVATE_FEEDBACK');
    expect(data.text).toBe('slow service');
  });

  it('draftReply generates + stores an AI reply (metered)', async () => {
    prisma.review.findFirst.mockResolvedValue({ id: 'rev1', rating: 5, text: 'great' });
    const res = await svc.draftReply(WS, 'rev1');
    expect(res.replyDraft).toContain('Thank you');
    expect(credits.reserve).toHaveBeenCalled();
    expect(prisma.review.update).toHaveBeenCalledWith(expect.objectContaining({ data: { replyDraft: expect.any(String) } }));
  });
});
