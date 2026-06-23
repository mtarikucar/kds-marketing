import { ReviewSyncService } from './review-sync.service';
import { anyReviewSyncConfigured, isReviewSyncConfigured } from './review-clients';

jest.mock('../../../common/scheduling/advisory-lock', () => ({
  withAdvisoryLock: jest.fn(async (_p: any, _n: any, cb: () => Promise<void>) => { await cb(); }),
}));
// Drive the per-source fetch deterministically.
jest.mock('./review-clients', () => {
  const actual = jest.requireActual('./review-clients');
  return { ...actual, fetchSourceReviews: jest.fn() };
});
import { fetchSourceReviews } from './review-clients';

const ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'META_APP_ID', 'META_APP_SECRET'];

function makeSvc() {
  const prisma = {
    reviewSource: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
    review: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  const outbox = { append: jest.fn().mockResolvedValue('e') };
  return { prisma, outbox, svc: new ReviewSyncService(prisma as any, outbox as any) };
}

describe('ReviewSyncService (Epic 13, inert review-sync)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); (fetchSourceReviews as jest.Mock).mockReset(); });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('isReviewSyncConfigured gates on the provider env', () => {
    expect(anyReviewSyncConfigured()).toBe(false);
    process.env.GOOGLE_CLIENT_ID = 'a'; process.env.GOOGLE_CLIENT_SECRET = 'b';
    expect(isReviewSyncConfigured('GOOGLE')).toBe(true);
    expect(isReviewSyncConfigured('FACEBOOK')).toBe(false);
  });

  it('is INERT when no provider is configured (no DB read)', async () => {
    const { prisma, svc } = makeSvc();
    await svc.syncDueSources();
    expect(prisma.reviewSource.findMany).not.toHaveBeenCalled();
  });

  it('upserts NEW reviews idempotently and raises ReviewReceived only for a low rating', async () => {
    process.env.GOOGLE_CLIENT_ID = 'a'; process.env.GOOGLE_CLIENT_SECRET = 'b';
    const { prisma, outbox, svc } = makeSvc();
    prisma.reviewSource.findMany.mockResolvedValue([{ id: 'src-1', workspaceId: 'ws-1', type: 'GOOGLE', placeId: null, externalRef: 'accounts/1/locations/2', accessToken: 'sealed' }]);
    (fetchSourceReviews as jest.Mock).mockResolvedValue([
      { externalReviewId: 'g1', rating: 2, text: 'bad', authorName: 'A', authoredAt: new Date() }, // low → emit
      { externalReviewId: 'g2', rating: 5, text: 'great', authorName: 'B', authoredAt: new Date() }, // high → no emit
    ]);
    prisma.review.findFirst.mockResolvedValue(null); // both new
    prisma.review.create.mockResolvedValueOnce({ id: 'rev-1' }).mockResolvedValueOnce({ id: 'rev-2' });
    await svc.syncDueSources();
    // both created with the scoped + idempotency fields
    expect(prisma.review.create).toHaveBeenCalledTimes(2);
    const d1 = prisma.review.create.mock.calls[0][0].data;
    expect(d1).toMatchObject({ workspaceId: 'ws-1', sourceId: 'src-1', source: 'GOOGLE', externalReviewId: 'g1', status: 'SYNCED' });
    expect(d1.token).toMatch(/^syn_/);
    // only the low-rating new review emits ReviewReceived (deduped key)
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.append.mock.calls[0][0]).toMatchObject({ type: 'marketing.review.received.v1', idempotencyKey: 'review-received:rev-1' });
    // source watermark stamped
    expect(prisma.reviewSource.update.mock.calls[0][0].data).toMatchObject({ lastError: null });
  });

  it('an existing review is refreshed (update), not re-created or re-emitted', async () => {
    process.env.GOOGLE_CLIENT_ID = 'a'; process.env.GOOGLE_CLIENT_SECRET = 'b';
    const { prisma, outbox, svc } = makeSvc();
    prisma.reviewSource.findMany.mockResolvedValue([{ id: 'src-1', workspaceId: 'ws-1', type: 'GOOGLE', placeId: null, externalRef: 'x', accessToken: 'sealed' }]);
    (fetchSourceReviews as jest.Mock).mockResolvedValue([{ externalReviewId: 'g1', rating: 1, text: 'still bad', authorName: 'A', authoredAt: new Date() }]);
    prisma.review.findFirst.mockResolvedValue({ id: 'rev-1' }); // already exists
    await svc.syncDueSources();
    expect(prisma.review.create).not.toHaveBeenCalled();
    expect(prisma.review.update).toHaveBeenCalledTimes(1);
    expect(outbox.append).not.toHaveBeenCalled(); // no re-emit for an existing review
  });

  it('a failing source stamps lastError and does not abort the sweep', async () => {
    process.env.GOOGLE_CLIENT_ID = 'a'; process.env.GOOGLE_CLIENT_SECRET = 'b';
    const { prisma, svc } = makeSvc();
    prisma.reviewSource.findMany.mockResolvedValue([
      { id: 'src-1', workspaceId: 'ws-1', type: 'GOOGLE', placeId: null, externalRef: 'x', accessToken: 'sealed' },
      { id: 'src-2', workspaceId: 'ws-1', type: 'GOOGLE', placeId: null, externalRef: 'y', accessToken: 'sealed' },
    ]);
    (fetchSourceReviews as jest.Mock).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([]);
    await svc.syncDueSources();
    // both sources got a watermark update; the first carries lastError
    expect(prisma.reviewSource.update).toHaveBeenCalledTimes(2);
    const errCall = prisma.reviewSource.update.mock.calls.find((c: any) => c[0].where.id === 'src-1')![0];
    expect(errCall.data.lastError).toContain('boom');
  });
});
