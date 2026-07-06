import { UnifiedCalendarService } from './unified-calendar.service';

function makePrisma(posts: any[], items: any[]) {
  return {
    prisma: {
      socialPost: { findMany: jest.fn().mockResolvedValue(posts) },
      socialCampaignItem: { findMany: jest.fn().mockResolvedValue(items) },
    } as any,
  };
}

describe('UnifiedCalendarService', () => {
  it('merges social posts + campaign items into one time-ordered list', async () => {
    const { prisma } = makePrisma(
      [{ id: 'p1', content: 'Hello world', status: 'SCHEDULED', scheduledAt: new Date('2026-07-10T09:00:00Z'), campaignItemId: null }],
      [{ id: 'i1', topic: 'Implant offer', status: 'PLANNED', scheduledFor: new Date('2026-07-08T09:00:00Z') }],
    );
    const svc = new UnifiedCalendarService(prisma);
    const out = await svc.range('ws1', new Date('2026-07-01Z'), new Date('2026-07-31Z'));
    expect(out.map((x) => x.id)).toEqual(['i1', 'p1']); // sorted by time (i1 earlier)
    expect(out[0]).toMatchObject({ type: 'CAMPAIGN_ITEM', title: 'Implant offer' });
    expect(out[1]).toMatchObject({ type: 'SOCIAL_POST', title: 'Hello world' });
  });

  // Audit trim #2: a confirmed AI-campaign item materializes a scheduled
  // SocialPost that carries campaignItemId back to the item — from then on the
  // calendar used to render BOTH rows for the same slot. The post (the real,
  // publishable thing) wins; its source campaign item is suppressed.
  it('deduplicates a campaign item whose SocialPost is already scheduled (post wins)', async () => {
    const { prisma } = makePrisma(
      [{ id: 'p1', content: 'Generated caption', status: 'SCHEDULED', scheduledAt: new Date('2026-07-08T09:00:00Z'), campaignItemId: 'i1' }],
      [
        { id: 'i1', topic: 'Implant offer', status: 'SCHEDULED', scheduledFor: new Date('2026-07-08T09:00:00Z') },
        { id: 'i2', topic: 'Follow-up tip', status: 'PLANNED', scheduledFor: new Date('2026-07-09T09:00:00Z') },
      ],
    );
    const svc = new UnifiedCalendarService(prisma);
    const out = await svc.range('ws1', new Date('2026-07-01Z'), new Date('2026-07-31Z'));
    // i1 is suppressed (its post shows); i2 (not yet materialized) still shows.
    expect(out.map((x) => `${x.type}:${x.id}`)).toEqual(['SOCIAL_POST:p1', 'CAMPAIGN_ITEM:i2']);
  });

  it('truncates long post titles and handles empty content', async () => {
    const { prisma } = makePrisma(
      [
        { id: 'p1', content: 'x'.repeat(200), status: 'DRAFT', scheduledAt: new Date('2026-07-10T09:00:00Z'), campaignItemId: null },
        { id: 'p2', content: '   ', status: 'DRAFT', scheduledAt: new Date('2026-07-11T09:00:00Z'), campaignItemId: null },
      ],
      [],
    );
    const svc = new UnifiedCalendarService(prisma);
    const out = await svc.range('ws1', new Date('2026-07-01Z'), new Date('2026-07-31Z'));
    expect(out[0].title.endsWith('…')).toBe(true);
    expect(out[1].title).toBe('Untitled post');
  });
});
