import { CAP, HomeTimelineService } from './home-timeline.service';

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

  it('asks the database for everything but CANCELLED, and keeps the DRAFT rows it gets back', async () => {
    // The exclusion is a WHERE clause, so a mock can only prove we asked for it;
    // what the mock CAN prove is the other half — that a DRAFT row coming back
    // is not then dropped by some second guess in the mapping.
    const { svc, prisma } = make({
      campaign: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Taslak', scheduledAt: new Date('2026-08-28T10:00:00Z'), status: 'DRAFT' }]) },
      socialCampaign: { findMany: jest.fn().mockResolvedValue([{ id: 's1', name: 'Sosyal taslak', startDate: new Date('2026-08-28T11:00:00Z'), status: 'DRAFT' }]) },
    });

    const out = await svc.timeline(WS, FROM, TO);

    const p = prisma as never as Record<string, { findMany: jest.Mock }>;
    expect(p.campaign.findMany.mock.calls[0][0].where.status).toEqual({ not: 'CANCELLED' });
    expect(p.socialCampaign.findMany.mock.calls[0][0].where.status).toEqual({ not: 'CANCELLED' });
    expect(out.items.map((i) => i.status)).toEqual(['DRAFT', 'DRAFT']);
  });

  it('maps a social campaign onto the campaign lane', async () => {
    const { svc } = make({
      socialCampaign: { findMany: jest.fn().mockResolvedValue([{ id: 's1', name: 'Eylül serisi', startDate: new Date('2026-08-28T11:00:00Z'), status: 'ACTIVE' }]) },
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.items).toEqual([
      { kind: 'campaign', id: 's1', title: 'Eylül serisi', at: '2026-08-28T11:00:00.000Z', status: 'ACTIVE' },
    ]);
  });

  it('drops a cron whose next run falls outside the window', async () => {
    const { svc, jobs } = make();
    jobs.listCronHeartbeats.mockResolvedValue({
      registered: [
        { name: 'in-window', nextAt: new Date('2026-08-28T03:00:00Z') },
        { name: 'after-window', nextAt: new Date('2026-08-30T03:00:00Z') },
        { name: 'before-window', nextAt: new Date('2026-08-27T03:00:00Z') },
        { name: 'unscheduled', nextAt: null },
      ],
      recorded: [],
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.items.map((i) => i.title)).toEqual(['in-window']);
  });

  it('reports failed sources in a stable order however the failures land', async () => {
    const slow = () => new Promise((_r, rej) => setTimeout(() => rej(new Error('slow')), 5));
    const { svc } = make({
      socialCampaign: { findMany: jest.fn().mockRejectedValue(new Error('fast')) },
      marketingTask: { findMany: jest.fn().mockImplementation(slow) },
    });

    const out = await svc.timeline(WS, FROM, TO);

    // 'sosyal kampanyalar' rejects first but must not sort first.
    expect(out.unread).toEqual(['görevler', 'sosyal kampanyalar']);
  });

  it('names a source that hit the row cap, and leaves alone one that did not', async () => {
    const rows = (n: number, at: string) =>
      Array.from({ length: n }, (_v, i) => ({ id: `x${i}`, name: 'Demo', startAt: new Date(at) }));
    const { svc } = make({
      booking: { findMany: jest.fn().mockResolvedValue(rows(CAP, '2026-08-28T14:00:00Z')) },
      marketingTask: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: CAP - 1 }, (_v, i) => ({
            id: `t${i}`,
            title: 'Ara',
            dueDate: new Date('2026-08-28T09:00:00Z'),
            status: 'PENDING',
          })),
        ),
      },
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.truncated).toEqual(['randevular']);
    expect(out.unread).toEqual([]);
    expect(out.items).toHaveLength(CAP * 2 - 1);
  });

  it('calls a source that threw unread, never truncated', async () => {
    const { svc } = make({
      marketingTask: { findMany: jest.fn().mockRejectedValue(new Error('boom')) },
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.unread).toEqual(['görevler']);
    expect(out.truncated).toEqual([]);
  });
});
