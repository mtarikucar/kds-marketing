import { DailyDigestService } from './daily-digest.service';

/**
 * Everything else the product schedules notifies IN-app and per-object — this
 * lead is due, this approval is waiting — so none of it reaches someone who is
 * not already looking at the panel. That is exactly the person a self-running
 * system is for. This is the one message that arrives unasked, which is why it
 * has to be worth opening every time.
 */
describe('DailyDigestService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let usage: { breakdown: jest.Mock };
  let svc: DailyDigestService;

  const counts = (over: Record<string, number> = {}) => {
    const n = (k: string) => over[k] ?? 0;
    prisma.lead.count = jest
      .fn()
      .mockResolvedValueOnce(n('newLeads'))
      .mockResolvedValueOnce(n('won'))
      .mockResolvedValueOnce(n('dueFollowUps'))
      .mockResolvedValueOnce(n('unassigned'));
    prisma.message.count = jest.fn().mockResolvedValue(n('inbound'));
    prisma.approvalRequest.count = jest.fn().mockResolvedValue(n('approvals'));
    prisma.researchCandidate.count = jest.fn().mockResolvedValue(n('candidates'));
    prisma.marketingTask.count = jest
      .fn()
      .mockResolvedValueOnce(n('overdue'))
      .mockResolvedValueOnce(n('dueToday'));
  };

  beforeEach(() => {
    usage = { breakdown: jest.fn().mockResolvedValue({ total: { usd: 1.61 } }) };
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, name: 'HummyTummy' }) },
      lead: { count: jest.fn() },
      message: { count: jest.fn() },
      approvalRequest: { count: jest.fn() },
      researchCandidate: { count: jest.fn() },
      marketingTask: { count: jest.fn() },
      workspaceMembership: { findMany: jest.fn() },
      marketingUser: { findMany: jest.fn() },
    };
    svc = new DailyDigestService(prisma, usage as never);
  });

  it('is empty when nothing happened and nothing waits', async () => {
    counts();
    const d = await svc.build(WS);
    // Silence is the feature: an email that is empty most mornings gets
    // filtered, and the one that matters gets filtered with it.
    expect(d!.empty).toBe(true);
  });

  it('does not send on cost alone — spend is context, not news', async () => {
    // $1.61 was still burned overnight; it is reported when there is something
    // to report it against, but it never triggers the email by itself.
    counts();
    const d = await svc.build(WS);
    expect(d!.empty).toBe(true);
    expect(d!.didHappen.items.join(' ')).toContain('$1.61');
  });

  it('reports overnight work and what it cost', async () => {
    counts({ newLeads: 47, inbound: 3, won: 1 });
    const d = await svc.build(WS);
    expect(d!.empty).toBe(false);
    expect(d!.didHappen.items.join(' ')).toContain('47 yeni lead');
    expect(d!.didHappen.items.join(' ')).toContain('$1.61');
  });

  it('separates what the machine cannot finish alone', async () => {
    counts({ approvals: 2, candidates: 9, overdue: 3, unassigned: 360 });
    const d = await svc.build(WS);
    const text = d!.needsYou.items.join(' | ');
    expect(text).toContain('2 onay bekliyor');
    expect(text).toContain('9 araştırma adayı');
    expect(text).toContain('3 görev gecikmiş');
    expect(text).toContain('360 yeni lead kimseye atanmamış');
  });

  it('survives a metering outage rather than skipping the whole brief', async () => {
    usage.breakdown.mockRejectedValue(new Error('db down'));
    counts({ newLeads: 5 });
    const d = await svc.build(WS);
    // The cost line is a nice-to-have; the leads are the point.
    expect(d!.didHappen.items.join(' ')).toContain('5 yeni lead');
  });

  it('renders a checklist and omits empty sections', async () => {
    counts({ approvals: 1 });
    const body = svc.render((await svc.build(WS))!);
    expect(body).toContain('[ ] 1 onay bekliyor');
    expect(body).toContain('Sensiz ilerlemiyor');
    // "Bugün" had no items, so its heading must not be rendered empty.
    expect(body).not.toContain('Bugün:');
  });

  it('addresses OWNER and MANAGER, never the SYSTEM sentinel', async () => {
    prisma.workspaceMembership.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    prisma.marketingUser.findMany.mockResolvedValue([{ email: 'a@x.io' }, { email: 'b@x.io' }]);

    const to = await svc.recipients(WS);
    expect(to).toEqual(['a@x.io', 'b@x.io']);
    expect(prisma.workspaceMembership.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'ACTIVE',
      role: { in: ['OWNER', 'MANAGER'] },
    });
    // The research sentinel owns rows but has no mailbox — it would bounce
    // every single morning.
    expect(prisma.marketingUser.findMany.mock.calls[0][0].where.role).toEqual({ not: 'SYSTEM' });
  });

  it('returns no recipients rather than guessing when nobody qualifies', async () => {
    prisma.workspaceMembership.findMany.mockResolvedValue([]);
    await expect(svc.recipients(WS)).resolves.toEqual([]);
    expect(prisma.marketingUser.findMany).not.toHaveBeenCalled();
  });
});
