import { HomeTimelineService } from './home-timeline.service';

const WS = 'ws-1';
const FROM = new Date('2026-08-28T00:00:00Z');
const TO = new Date('2026-08-29T00:00:00Z');

function make(over: Partial<Record<string, unknown>> = {}) {
  const prisma = {
    marketingTask: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    socialCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    campaign: { findMany: jest.fn().mockResolvedValue([]) },
    ...over,
  } as never;
  const jobs = { listCronHeartbeats: jest.fn().mockResolvedValue({ registered: [], recorded: [] }) };
  return { svc: new HomeTimelineService(prisma, jobs as never), prisma, jobs };
}

describe('HomeTimelineService', () => {
  it('merges four sources onto one axis, sorted by time, each tagged with its kind', async () => {
    const { svc, jobs } = make({
      marketingTask: { findMany: jest.fn().mockResolvedValue([{ id: 't1', title: 'Hasan Usta ara', dueDate: new Date('2026-08-28T09:00:00Z'), status: 'PENDING' }]) },
      booking: { findMany: jest.fn().mockResolvedValue([{ id: 'b1', name: 'Demo', startAt: new Date('2026-08-28T14:00:00Z') }]) },
      campaign: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Eylül maili', scheduledAt: new Date('2026-08-28T18:00:00Z'), status: 'SCHEDULED' }]) },
    });
    jobs.listCronHeartbeats.mockResolvedValue({
      registered: [{ name: 'research-nightly', nextAt: new Date('2026-08-28T03:00:00Z') }],
      recorded: [],
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.items.map((i) => i.kind)).toEqual(['system', 'task', 'appointment', 'campaign']);
    expect(out.items[0].title).toBe('research-nightly');
    expect(out.items[1].title).toBe('Hasan Usta ara');
    expect(out.unread).toEqual([]);
  });

  it('names a source it could not read instead of returning a short list silently', async () => {
    const { svc } = make({
      marketingTask: { findMany: jest.fn().mockRejectedValue(new Error('boom')) },
      booking: { findMany: jest.fn().mockResolvedValue([{ id: 'b1', name: 'Demo', startAt: new Date('2026-08-28T14:00:00Z') }]) },
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.items).toHaveLength(1);
    expect(out.unread).toEqual(['görevler']);
  });

  it('scopes every source to the workspace', async () => {
    const { svc, prisma } = make();
    await svc.timeline(WS, FROM, TO);
    for (const model of ['marketingTask', 'booking', 'socialCampaign', 'campaign'] as const) {
      const arg = (prisma as never as Record<string, { findMany: jest.Mock }>)[model].findMany.mock.calls[0][0];
      expect(arg.where.workspaceId).toBe(WS);
    }
  });
});
