import { CAP, HomeTimelineService } from './home-timeline.service';

const WS = 'ws-1';
const FROM = new Date('2026-08-28T00:00:00Z');
const TO = new Date('2026-08-29T00:00:00Z');

function make(
  over: Partial<Record<string, unknown>> = {},
  researchQueue: { queueStatus?: jest.Mock } = {},
) {
  const prisma = {
    marketingTask: { findMany: jest.fn().mockResolvedValue([]) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    socialCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    campaign: { findMany: jest.fn().mockResolvedValue([]) },
    ...over,
  } as never;
  const jobs = { listCronHeartbeats: jest.fn().mockResolvedValue({ registered: [], recorded: [] }) };
  const research = {
    queueStatus:
      researchQueue.queueStatus ??
      jest.fn().mockResolvedValue({
        mode: 'SERVER',
        pending: 0,
        claimed: 0,
        oldestPendingAt: null,
        oldestPendingAgeHours: null,
        pendingApprovals: 0,
      }),
  };
  return { svc: new HomeTimelineService(prisma, jobs as never, research as never), prisma, jobs, research };
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
    // Concatenation puts socials (11:00) before campaigns (10:00); only the sort
    // can produce this order, so the assertion is on id, not on two equal values.
    expect(out.items.map((i) => i.id)).toEqual(['c1', 's1']);
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

  it('names a source with more rows behind the cap, and stays quiet about one that stopped exactly at it', async () => {
    // The boundary is the whole point: a source that returned CAP rows and had
    // nothing more is COMPLETE, and calling it truncated would be a false alarm
    // — the same lie as a silent one, told the other way round.
    const { svc } = make({
      booking: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: CAP + 1 }, (_v, i) => ({
            id: `b${i}`,
            name: 'Demo',
            startAt: new Date('2026-08-28T14:00:00Z'),
          })),
        ),
      },
      marketingTask: {
        findMany: jest.fn().mockResolvedValue(
          Array.from({ length: CAP }, (_v, i) => ({
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
    // The extra row is trimmed, not rendered: CAP bookings + CAP tasks.
    expect(out.items).toHaveLength(CAP * 2);
    expect(out.items.filter((i) => i.kind === 'appointment')).toHaveLength(CAP);
  });

  it('calls a source that threw unread, never truncated', async () => {
    const { svc } = make({
      marketingTask: { findMany: jest.fn().mockRejectedValue(new Error('boom')) },
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.unread).toEqual(['görevler']);
    expect(out.truncated).toEqual([]);
  });

  it('asks each source for its own window, its own status filter, and one row past the cap', async () => {
    // Everything here is a query argument, so mocked rows can never show it:
    // a source that quietly stopped filtering by date or by status would still
    // return whatever the mock hands back. Only the call arguments show it.
    const { svc, prisma } = make();
    await svc.timeline(WS, FROM, TO);
    const expected = {
      marketingTask: { on: 'dueDate', status: { in: ['PENDING', 'IN_PROGRESS'] } },
      booking: { on: 'startAt', status: 'CONFIRMED' },
      socialCampaign: { on: 'startDate', status: { not: 'CANCELLED' } },
      campaign: { on: 'scheduledAt', status: { not: 'CANCELLED' } },
    } as const;
    for (const [model, e] of Object.entries(expected)) {
      const arg = (prisma as never as Record<string, { findMany: jest.Mock }>)[model].findMany.mock
        .calls[0][0];
      expect(arg.where[e.on]).toEqual({ gte: FROM, lte: TO });
      expect(arg.where.status).toEqual(e.status);
      expect(arg.orderBy).toEqual({ [e.on]: 'asc' });
      // CAP + 1: one row past the cap is how "there is more" is detected.
      expect(arg.take).toBe(CAP + 1);
    }
  });

  it('names the cron source when it is the one that fails', async () => {
    // Cron is the odd path — `.then(...).catch(...)` rather than a direct
    // `.catch` — so its failure is the easiest one to wire up wrong.
    const { svc, jobs } = make({
      booking: { findMany: jest.fn().mockResolvedValue([{ id: 'b1', name: 'Demo', startAt: new Date('2026-08-28T14:00:00Z') }]) },
    });
    jobs.listCronHeartbeats.mockRejectedValue(new Error('registry gone'));

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.unread).toEqual(['sistem işleri']);
    expect(out.items.map((i) => i.id)).toEqual(['b1']);
  });

  it('echoes back the window it was asked about', async () => {
    // `from`/`to` are what tells a reader which window the rows beside them
    // describe; an echo that drifts mislabels a correct list.
    const { svc } = make();

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.from).toBe(FROM.toISOString());
    expect(out.to).toBe(TO.toISOString());
  });
});

/**
 * The research queue nobody may have drained.
 *
 * A workspace can hand its nightly research to its OWN Claude
 * (`researchExecution: 'MCP'`), at which point the platform stops draining the
 * queue and waits. If the owner never schedules a drainer — or theirs breaks —
 * jobs pile up, no candidates appear, and the review queue is empty. That is
 * indistinguishable from "research ran and found nothing", and the two need
 * opposite fixes.
 *
 * So the count and the age of the oldest waiting job are read and reported by
 * name, and a FAILED read names itself in `unread` rather than rendering as a
 * quiet zero. This is the same rule the four calendar sources above follow, and
 * the same one the daily brief broke with `.catch(() => 0)` in v2.271.0.
 */
describe('HomeTimelineService — the un-drained research queue', () => {
  it('reports the pending count and the age of the oldest job, by name', async () => {
    const { svc } = make({}, {
      queueStatus: jest.fn().mockResolvedValue({
        mode: 'MCP',
        pending: 4,
        claimed: 1,
        oldestPendingAt: '2026-08-28T03:00:00.000Z',
        oldestPendingAgeHours: 74,
        pendingApprovals: 2,
      }),
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.research).toEqual({
      mode: 'MCP',
      pending: 4,
      claimed: 1,
      oldestPendingAt: '2026-08-28T03:00:00.000Z',
      oldestPendingAgeHours: 74,
      pendingApprovals: 2,
    });
    expect(out.unread).toEqual([]);
  });

  it('NAMES the source when the queue cannot be read, and returns no number at all', async () => {
    // The mutation this test exists to catch: falling back to `{ pending: 0 }`
    // would render as "nothing is waiting" — a confident wrong answer where the
    // truth is "we could not look".
    const { svc } = make({}, {
      queueStatus: jest.fn().mockRejectedValue(new Error('scheduled_jobs on fire')),
    });

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.research).toBeNull();
    expect(out.unread).toEqual(['araştırma kuyruğu']);
  });

  it('does not shorten the calendar when the research read fails', async () => {
    const { svc } = make(
      {
        marketingTask: {
          findMany: jest.fn().mockResolvedValue([
            { id: 't1', title: 'Ara', dueDate: new Date('2026-08-28T09:00:00Z'), status: 'PENDING' },
          ]),
        },
      },
      { queueStatus: jest.fn().mockRejectedValue(new Error('down')) },
    );

    const out = await svc.timeline(WS, FROM, TO);

    expect(out.items).toHaveLength(1);
    expect(out.unread).toEqual(['araştırma kuyruğu']);
  });

  it('scopes the queue read to the caller workspace', async () => {
    const queueStatus = jest.fn().mockResolvedValue({
      mode: 'SERVER', pending: 0, claimed: 0, oldestPendingAt: null, oldestPendingAgeHours: null, pendingApprovals: 0,
    });
    const { svc } = make({}, { queueStatus });

    await svc.timeline(WS, FROM, TO);

    expect(queueStatus).toHaveBeenCalledWith(WS);
  });
});
