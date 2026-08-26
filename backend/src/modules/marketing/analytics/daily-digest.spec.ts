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
      // Waiting-reply count is a column comparison, so it is raw SQL. Default
      // to none; the cases that care override it.
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
      socialAccount: { count: jest.fn().mockResolvedValue(0) },
      scheduledJob: { count: jest.fn().mockResolvedValue(0) },
      adAccount: { count: jest.fn().mockResolvedValue(0) },
      socialCampaign: { count: jest.fn().mockResolvedValue(0) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
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

/**
 * A customer waiting for a reply.
 *
 * The brief covered approvals, candidates, tasks and leads but never
 * conversations — the word appeared once in the whole service, in the docstring
 * listing what it covers. So the most time-sensitive item in the inbox was the
 * one thing the morning email could not tell you about. On the live workspace a
 * WhatsApp thread sat on "bilgi almak icin dort gozle bekliyorum" for 46 days
 * with nothing anywhere reporting it.
 */
describe('DailyDigestService — conversations waiting for a reply', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: DailyDigestService;

  const build = (waiting: bigint) => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, name: 'HummyTummy' }) },
      lead: { count: jest.fn().mockResolvedValue(0) },
      message: { count: jest.fn().mockResolvedValue(0) },
      approvalRequest: { count: jest.fn().mockResolvedValue(0) },
      researchCandidate: { count: jest.fn().mockResolvedValue(0) },
      marketingTask: { count: jest.fn().mockResolvedValue(0) },
      workspaceMembership: { findMany: jest.fn() },
      marketingUser: { findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ count: waiting }]),
      socialAccount: { count: jest.fn().mockResolvedValue(0) },
      scheduledJob: { count: jest.fn().mockResolvedValue(0) },
      adAccount: { count: jest.fn().mockResolvedValue(0) },
      socialCampaign: { count: jest.fn().mockResolvedValue(0) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
    };
    svc = new DailyDigestService(prisma, { breakdown: jest.fn().mockResolvedValue(null) } as never);
    return prisma;
  };

  it('lists waiting conversations under "needs you"', async () => {
    build(3n);

    const d = await svc.build(WS);

    expect(d!.needsYou.items.join(' | ')).toMatch(/3 konuşma yanıt bekliyor/);
  });

  it('is the only thing keeping an otherwise silent morning from being empty', async () => {
    // Nothing happened, nothing else waits — but a customer is still hanging.
    // Before this the digest would have gone out empty, i.e. not at all.
    build(1n);

    const d = await svc.build(WS);

    expect(d!.empty).toBe(false);
  });

  it('says nothing when every thread has been answered', async () => {
    build(0n);

    const d = await svc.build(WS);

    expect(d!.needsYou.items.join(' | ')).not.toMatch(/yanıt bekliyor/);
  });

  it('survives a failed count rather than losing the whole brief', async () => {
    const p = build(0n);
    p.$queryRaw.mockRejectedValue(new Error('db hiccup'));

    // One unavailable number must not cost the owner the other four.
    await expect(svc.build(WS)).resolves.toBeTruthy();
  });
});

/**
 * An account that stopped working.
 *
 * Every reconnect this session — figurunica, the mis-tagged Page, the expired
 * Meta ad tokens — was surfaced to the owner by someone reading the database
 * and telling them. The morning brief never mentioned accounts at all: the
 * words socialAccount, channel and needsReconnect appeared zero times in the
 * service.
 *
 * The predicate is deliberately NARROWER than social.tools.ts's
 * `needsReconnect`, which also folds in `enabled: false`. An account the owner
 * disconnected on purpose is not a problem, and repeating it every morning
 * forever is how a section trains people to stop reading it.
 */
describe('DailyDigestService — accounts that stopped working', () => {
  const WS = 'ws-1';

  const build = (broken: number) => {
    const prisma: any = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, name: 'HummyTummy' }) },
      lead: { count: jest.fn().mockResolvedValue(0) },
      message: { count: jest.fn().mockResolvedValue(0) },
      approvalRequest: { count: jest.fn().mockResolvedValue(0) },
      researchCandidate: { count: jest.fn().mockResolvedValue(0) },
      marketingTask: { count: jest.fn().mockResolvedValue(0) },
      workspaceMembership: { findMany: jest.fn() },
      marketingUser: { findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
      socialAccount: { count: jest.fn().mockResolvedValue(broken) },
      scheduledJob: { count: jest.fn().mockResolvedValue(0) },
      adAccount: { count: jest.fn().mockResolvedValue(0) },
      socialCampaign: { count: jest.fn().mockResolvedValue(0) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
    };
    const svc = new DailyDigestService(
      prisma,
      { breakdown: jest.fn().mockResolvedValue(null) } as never,
    );
    return { prisma, svc };
  };

  it('reports an account whose authorisation has lapsed', async () => {
    const { svc } = build(2);

    const d = await svc.build(WS);

    expect(d!.needsYou.items.join(' | ')).toMatch(/2 bağlı hesabın yetkisi düşmüş/);
  });

  it('asks only about accounts that are supposed to be working', async () => {
    const { prisma, svc } = build(0);

    await svc.build(WS);

    const where = prisma.socialAccount.count.mock.calls[0][0].where;
    // A deliberate disconnect writes lastError 'disconnected' and enabled:false.
    // Neither branch here matches that, so it never nags about it.
    expect(where.OR).toEqual([
      { lastError: 'reauth_required' },
      { enabled: true, tokenExpiresAt: { lt: expect.any(Date) } },
    ]);
    expect(where.workspaceId).toBe(WS);
  });

  it('says nothing when every account is healthy', async () => {
    const { svc } = build(0);

    const d = await svc.build(WS);

    expect(d!.needsYou.items.join(' | ')).not.toMatch(/yetkisi düşmüş/);
  });
});

/**
 * Connections that have broken, and connections about to.
 *
 * The brief only ever looked at SocialAccount. An AdAccount in TOKEN_EXPIRED —
 * a state our own code writes the moment Meta or TikTok answers with an auth
 * error — was invisible, while insights stopped syncing, spend reporting went
 * stale and the budget autopilot could not act. One of the three ad accounts on
 * the live workspace has been sitting like that.
 *
 * And reporting a broken connection is the wrong moment on its own: nobody can
 * reconnect retroactively, so by then the posts that did not go out have not
 * gone out. An expiry is one of the few failures that announces itself in
 * advance; the only reason it surprises anyone is that nothing read the date.
 */
describe('DailyDigestService — connection health', () => {
  const WS2 = 'ws-conn';
  const build = (social: number, ad: number, socialSoon: number, adSoon: number) => {
    const socialCount = jest
      .fn()
      .mockResolvedValueOnce(social)
      .mockResolvedValueOnce(socialSoon);
    const adCount = jest.fn().mockResolvedValueOnce(ad).mockResolvedValueOnce(adSoon);
    const prisma: any = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS2, name: 'HummyTummy' }) },
      lead: { count: jest.fn().mockResolvedValue(0) },
      message: { count: jest.fn().mockResolvedValue(0) },
      approvalRequest: { count: jest.fn().mockResolvedValue(0) },
      researchCandidate: { count: jest.fn().mockResolvedValue(0) },
      marketingTask: { count: jest.fn().mockResolvedValue(0) },
      workspaceMembership: { findMany: jest.fn() },
      marketingUser: { findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
      scheduledJob: { count: jest.fn().mockResolvedValue(0) },
      socialCampaign: { count: jest.fn().mockResolvedValue(0) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
      socialAccount: { count: socialCount },
      adAccount: { count: adCount },
    };
    return {
      prisma,
      svc: new DailyDigestService(prisma, { breakdown: jest.fn().mockResolvedValue(null) } as never),
    };
  };

  it('counts a broken ad account alongside a broken social account', async () => {
    const { svc } = build(1, 1, 0, 0);

    const d = await svc.build(WS2);

    expect(d!.needsYou.items.join(' | ')).toMatch(/2 bağlı hesabın yetkisi düşmüş/);
  });

  it('only TOKEN_EXPIRED ad accounts count — DISCONNECTED is a decision, not a fault', async () => {
    const { prisma, svc } = build(0, 0, 0, 0);
    await svc.build(WS2);

    expect(prisma.adAccount.count.mock.calls[0][0].where.status).toBe('TOKEN_EXPIRED');
  });

  it('warns about a token expiring within the week, on its own line', async () => {
    const { svc } = build(0, 0, 1, 1);

    const d = await svc.build(WS2);
    const items = d!.needsYou.items.join(' | ');

    expect(items).toMatch(/2 bağlı hesabın yetkisi bir hafta içinde doluyor/);
    // Distinct from the broken line: "will stop" and "has stopped" call for
    // different actions and must not be collapsed into one number.
    expect(items).not.toMatch(/bağlı hesabın yetkisi düşmüş/);
  });

  it('looks ahead, not behind — the window opens at now, not at the epoch', async () => {
    const { prisma, svc } = build(0, 0, 1, 0);
    const before = Date.now();
    await svc.build(WS2);

    const where = prisma.socialAccount.count.mock.calls[1][0].where;
    // An ALREADY-expired token belongs to the broken line above; counting it
    // here as well would report the same account twice with two different
    // instructions.
    expect(where.tokenExpiresAt.gt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(where.enabled).toBe(true);
  });
});
