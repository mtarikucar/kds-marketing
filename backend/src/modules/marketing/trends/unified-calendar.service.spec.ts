import { UnifiedCalendarService } from './unified-calendar.service';

function makePrisma(posts: any[], items: any[]) {
  return {
    prisma: {
      socialPost: { findMany: jest.fn().mockResolvedValue(posts) },
      socialCampaignItem: { findMany: jest.fn().mockResolvedValue(items) },
      weeklyPlanItem: { findMany: jest.fn().mockResolvedValue([]) },
    } as any,
  };
}

describe('UnifiedCalendarService', () => {
  it('merges social posts + campaign items into one time-ordered list', async () => {
    const { prisma } = makePrisma(
      [{ id: 'p1', content: 'Hello world', status: 'SCHEDULED', scheduledAt: new Date('2026-07-10T09:00:00Z') }],
      [{ id: 'i1', topic: 'Implant offer', status: 'PLANNED', scheduledFor: new Date('2026-07-08T09:00:00Z') }],
    );
    const svc = new UnifiedCalendarService(prisma);
    const out = await svc.range('ws1', new Date('2026-07-01Z'), new Date('2026-07-31Z'));
    expect(out.map((x) => x.id)).toEqual(['i1', 'p1']); // sorted by time (i1 earlier)
    expect(out[0]).toMatchObject({ type: 'CAMPAIGN_ITEM', title: 'Implant offer' });
    expect(out[1]).toMatchObject({ type: 'SOCIAL_POST', title: 'Hello world' });
  });

  it('truncates long post titles and handles empty content', async () => {
    const { prisma } = makePrisma(
      [
        { id: 'p1', content: 'x'.repeat(200), status: 'DRAFT', scheduledAt: new Date('2026-07-10T09:00:00Z') },
        { id: 'p2', content: '   ', status: 'DRAFT', scheduledAt: new Date('2026-07-11T09:00:00Z') },
      ],
      [],
    );
    const svc = new UnifiedCalendarService(prisma);
    const out = await svc.range('ws1', new Date('2026-07-01Z'), new Date('2026-07-31Z'));
    expect(out[0].title.endsWith('…')).toBe(true);
    expect(out[1].title).toBe('Untitled post');
  });
});
