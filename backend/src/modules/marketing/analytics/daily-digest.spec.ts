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
      growthBudget: { findFirst: jest.fn().mockResolvedValue(null) },
      marketingDistributionConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      // The strategy autopilot's lane + its plan. Default to a workspace that
      // never armed autonomy, so every pre-existing expectation in this file
      // describes the brief an ordinary workspace still receives.
      marketingStrategy: { findUnique: jest.fn().mockResolvedValue(null) },
      strategyAction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    svc = new DailyDigestService(prisma, usage as never, { workspaceStatus: jest.fn().mockResolvedValue(null) } as never);
  });

  it('says which signals it could not read, instead of reporting them as zero', async () => {
    counts();
    // The waiting-reply and agentless-channel counts both ride $queryRaw. A
    // broken query used to render as "0 conversations waiting" — identical to
    // genuinely nobody waiting, and the reassuring one of the two.
    prisma.$queryRaw = jest.fn().mockRejectedValue(new Error('relation does not exist'));

    const d = await svc.build(WS);

    const line = d!.needsYou.items.find((l: string) => l.includes('okunamadı'));
    expect(line).toBeDefined();
    expect(line).toContain('yanıt bekleyen konuşmalar');
    expect(line).toContain('ajansız kanallar');
    // The point of the wording: a missing number is not an all-clear.
    expect(line).toContain('"sorun yok" demek değil');
  });

  it('still delivers every signal that DID work when one fails', async () => {
    counts({ overdue: 4 });
    prisma.$queryRaw = jest.fn().mockRejectedValue(new Error('boom'));

    const d = await svc.build(WS);

    // One broken sub-query must not cost the owner the other seventeen.
    expect(d!.needsYou.items.some((l: string) => l.includes('4 görev gecikmiş'))).toBe(true);
    // And the caveat leads, so it qualifies the counts printed under it.
    expect(d!.needsYou.items[0]).toContain('okunamadı');
  });

  it('adds no caveat when every signal reads cleanly', async () => {
    counts({ overdue: 1 });
    const d = await svc.build(WS);
    expect(d!.needsYou.items.some((l: string) => l.includes('okunamadı'))).toBe(false);
  });

  it('says when the ad budget still points at a month that has ended', async () => {
    counts();
    prisma.growthBudget.findFirst = jest.fn().mockResolvedValue({ periodKey: '2026-07' });

    const d = await svc.build(WS, new Date('2026-08-27T06:00:00Z'));

    const line = d!.needsYou.items.find((l: string) => l.includes('2026-07'));
    // The panel keeps showing AUTONOMOUS; only the engine knows it dropped to
    // the approval gate. Saying which month makes the fix obvious.
    expect(line).toBeDefined();
    expect(line).toContain('onaya düşüyor');
  });

  it('stays quiet when the budget is for the current month', async () => {
    counts();
    // The query itself filters on periodKey, so a current-month budget simply
    // does not come back — the line must not fire on an empty result.
    prisma.growthBudget.findFirst = jest.fn().mockResolvedValue(null);
    const d = await svc.build(WS, new Date('2026-08-27T06:00:00Z'));
    expect(d!.needsYou.items.some((l: string) => l.includes('dönemine ait'))).toBe(false);
  });

  it('says the distribution switch is off, not just that leads are unassigned', async () => {
    counts({ unassigned: 363 });
    prisma.marketingDistributionConfig.findUnique = jest.fn().mockResolvedValue({ strategy: 'DISABLED' });

    const line = (await svc.build(WS))!.needsYou.items.find((l: string) => l.includes('363'));

    expect(line).toContain('KAPALI');
    // The half an owner cannot guess: pickAssignee runs at ingress only, so
    // flipping the switch does not reach a lead already sitting there.
    expect(line).toContain('bundan sonra gelenleri');
  });

  it('says something different when distribution is ON and leads are still unowned', async () => {
    counts({ unassigned: 12 });
    prisma.marketingDistributionConfig.findUnique = jest
      .fn()
      .mockResolvedValue({ strategy: 'ROUND_ROBIN' });

    const line = (await svc.build(WS))!.needsYou.items.find((l: string) => l.includes('12'));

    // Same count, opposite problem: these arrived by a path auto-assignment
    // never covers, so "turn it on" is the wrong advice.
    expect(line).toContain('ROUND_ROBIN');
    expect(line).toContain('araştırma');
  });

  it('does not report the credit refusals twice, as jobs AND as a vendor problem', async () => {
    counts();
    // Live shape: every dead job was a credit refusal. scheduledJob.count is
    // called twice — deadJobs first, then the credit-error match.
    prisma.scheduledJob.count = jest
      .fn()
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(6);

    const items = (await svc.build(WS))!.needsYou.items as string[];

    expect(items.some((l) => l.includes('kredisi bitmiş'))).toBe(true);
    // The generic line explains nothing the line above has not, so it must go.
    expect(items.some((l) => l.includes('tüm denemelerini tüketip'))).toBe(false);
  });

  it('still reports the dead jobs the vendor line does not explain', async () => {
    counts();
    prisma.scheduledJob.count = jest
      .fn()
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(6);

    const items = (await svc.build(WS))!.needsYou.items as string[];

    // 9 dead, 6 of them credit — the other 3 have some other cause and are
    // exactly what this line is for.
    expect(items.some((l) => l.includes('3 arka plan işi'))).toBe(true);
    expect(items.some((l) => l.includes('kredisi bitmiş'))).toBe(true);
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
      growthBudget: { findFirst: jest.fn().mockResolvedValue(null) },
      marketingDistributionConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      marketingStrategy: { findUnique: jest.fn().mockResolvedValue(null) },
      strategyAction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    svc = new DailyDigestService(prisma, { breakdown: jest.fn().mockResolvedValue(null) } as never, { workspaceStatus: jest.fn().mockResolvedValue(null) } as never);
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
      growthBudget: { findFirst: jest.fn().mockResolvedValue(null) },
      marketingDistributionConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      marketingStrategy: { findUnique: jest.fn().mockResolvedValue(null) },
      strategyAction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new DailyDigestService(
      prisma,
      { breakdown: jest.fn().mockResolvedValue(null) } as never,
      { workspaceStatus: jest.fn().mockResolvedValue(null) } as never,
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
      growthBudget: { findFirst: jest.fn().mockResolvedValue(null) },
      marketingDistributionConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      marketingStrategy: { findUnique: jest.fn().mockResolvedValue(null) },
      strategyAction: { findMany: jest.fn().mockResolvedValue([]) },
      socialAccount: { count: socialCount },
      adAccount: { count: adCount },
    };
    return {
      prisma,
      svc: new DailyDigestService(prisma, { breakdown: jest.fn().mockResolvedValue(null) } as never, { workspaceStatus: jest.fn().mockResolvedValue(null) } as never),
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

/**
 * The vendor refusing us is not the same as us overspending, and only one of
 * the two was reportable.
 *
 * PlatformAiSpendCron exists to "say something BEFORE the money is gone", but
 * it compares our own RECORDED spend against our own cap. When the account runs
 * dry the calls fail and bill nothing, so recorded spend stays LOW and it reads
 * OK — structurally blind to the one failure it was written for. It also
 * announces to a log, which its own comment calls the same as no alert.
 *
 * Live, that is not hypothetical: the account had been running dry repeatedly
 * since 16 August, every AI reply was failing on the vendor's own 400, and no
 * surface said a word.
 */
describe('DailyDigestService — vendor refusal', () => {
  const WS3 = 'ws-vendor';
  const build = (refused: number, dead: number) => {
    // Order matters: dead-jobs count is asked before the refusal count.
    const scheduledJob = {
      count: jest.fn().mockResolvedValueOnce(dead).mockResolvedValueOnce(refused),
    };
    const prisma: any = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS3, name: 'HummyTummy' }) },
      lead: { count: jest.fn().mockResolvedValue(0) },
      message: { count: jest.fn().mockResolvedValue(0) },
      approvalRequest: { count: jest.fn().mockResolvedValue(0) },
      researchCandidate: { count: jest.fn().mockResolvedValue(0) },
      marketingTask: { count: jest.fn().mockResolvedValue(0) },
      workspaceMembership: { findMany: jest.fn() },
      marketingUser: { findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
      socialAccount: { count: jest.fn().mockResolvedValue(0) },
      adAccount: { count: jest.fn().mockResolvedValue(0) },
      socialCampaign: { count: jest.fn().mockResolvedValue(0) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
      growthBudget: { findFirst: jest.fn().mockResolvedValue(null) },
      marketingDistributionConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      marketingStrategy: { findUnique: jest.fn().mockResolvedValue(null) },
      strategyAction: { findMany: jest.fn().mockResolvedValue([]) },
      scheduledJob,
    };
    return {
      prisma,
      svc: new DailyDigestService(prisma, { breakdown: jest.fn().mockResolvedValue(null) } as never, { workspaceStatus: jest.fn().mockResolvedValue(null) } as never),
    };
  };

  it('names the cause instead of leaving it in a job record', async () => {
    const { svc } = build(3, 3);

    const d = await svc.build(WS3);

    expect(d!.needsYou.items.join(' | ')).toMatch(/kredisi bitmiş/);
  });

  it('matches the refusal on the vendor error the queue already stores', async () => {
    const { prisma, svc } = build(1, 1);
    await svc.build(WS3);

    const where = prisma.scheduledJob.count.mock.calls[1][0].where;
    // Read-side detection: nothing is added to the AI hot path, because the
    // vendor already told us and the queue already wrote it down.
    expect(where.lastError).toEqual({ contains: 'credit balance', mode: 'insensitive' });
    expect(where.workspaceId).toBe(WS3);
  });

  it('says nothing when the vendor is not refusing', async () => {
    const { svc } = build(0, 2);

    const d = await svc.build(WS3);
    const items = d!.needsYou.items.join(' | ');

    // Jobs can give up for many reasons; only this one means "top up the
    // account", so it must not be claimed on the strength of a failure count.
    expect(items).not.toMatch(/kredisi bitmiş/);
    expect(items).toMatch(/2 arka plan işi/);
  });
});

/**
 * The workspace's own AI budget.
 *
 * Hitting it SUSPENDS unattended work — nightly research stops finding leads —
 * and a stop nobody announced is exactly the failure this brief exists to
 * prevent. Measured live before the cap existed: a quiet day ran ~$0.45 and a
 * busy stretch ~$2.40/day for four days, which is ~$72/month from one
 * workspace. The average was never the problem; the peak was.
 */
describe('DailyDigestService — AI budget', () => {
  const WS4 = 'ws-budget';
  const build = (aiBudget: unknown) => {
    const prisma: any = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS4, name: 'W' }) },
      lead: { count: jest.fn().mockResolvedValue(0) },
      message: { count: jest.fn().mockResolvedValue(0) },
      approvalRequest: { count: jest.fn().mockResolvedValue(0) },
      researchCandidate: { count: jest.fn().mockResolvedValue(0) },
      marketingTask: { count: jest.fn().mockResolvedValue(0) },
      workspaceMembership: { findMany: jest.fn() },
      marketingUser: { findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
      socialAccount: { count: jest.fn().mockResolvedValue(0) },
      adAccount: { count: jest.fn().mockResolvedValue(0) },
      socialCampaign: { count: jest.fn().mockResolvedValue(0) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
      growthBudget: { findFirst: jest.fn().mockResolvedValue(null) },
      marketingDistributionConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      marketingStrategy: { findUnique: jest.fn().mockResolvedValue(null) },
      strategyAction: { findMany: jest.fn().mockResolvedValue([]) },
      scheduledJob: { count: jest.fn().mockResolvedValue(0) },
    };
    return new DailyDigestService(
      prisma,
      { breakdown: jest.fn().mockResolvedValue(null) } as never,
      { workspaceStatus: jest.fn().mockResolvedValue(aiBudget) } as never,
    );
  };

  it('says research has stopped when the budget is spent', async () => {
    const d = await build({ capUsd: 20, spentUsd: 20.4, ratio: 1.02, overCap: true }).build(WS4);

    expect(d!.needsYou.items.join(' | ')).toMatch(/AI aylık bütçesi doldu/);
  });

  it('warns before it stops, not only after', async () => {
    const d = await build({ capUsd: 20, spentUsd: 17, ratio: 0.85, overCap: false }).build(WS4);
    const items = d!.needsYou.items.join(' | ');

    // Nobody can un-spend a month; the useful moment is before the stop.
    expect(items).toMatch(/%85'i harcandı/);
    expect(items).not.toMatch(/bütçesi doldu/);
  });

  it('says nothing at all while the workspace is comfortably inside budget', async () => {
    const d = await build({ capUsd: 20, spentUsd: 4, ratio: 0.2, overCap: false }).build(WS4);

    expect(d!.needsYou.items.join(' | ')).not.toMatch(/bütçe/);
  });

  it('never reports both states for the same workspace', async () => {
    const d = await build({ capUsd: 20, spentUsd: 25, ratio: 1.25, overCap: true }).build(WS4);
    const items = d!.needsYou.items.join(' | ');

    expect(items).toMatch(/doldu/);
    expect(items).not.toMatch(/harcandı/);
  });

  it('stays quiet when the budget cannot be read', async () => {
    const d = await build(null).build(WS4);

    // A metering hiccup must not invent a budget line.
    expect(d!.needsYou.items.join(' | ')).not.toMatch(/bütçe/);
  });
});

/**
 * "What it did, and what it did NOT do and why."
 *
 * The owner asked never to DEAL with marketing. They did not ask never to
 * KNOW. A report that lists only successes is how a machine acting on someone's
 * behalf loses their trust, and it is also unfalsifiable: "nothing to report"
 * and "everything is blocked" render identically. These cases exist to keep the
 * second half of the report attached to the first.
 */
describe('DailyDigestService — the autopilot report', () => {
  const WS = 'ws-1';
  const NOW = new Date('2026-09-02T09:00:00Z');
  const YESTERDAY = new Date('2026-09-01T20:00:00Z');
  const LAST_WEEK = new Date('2026-08-23T10:00:00Z');
  // NOW (2026-09-02) is a Wednesday; this is the Monday the weekly lines ride.
  const MONDAY = new Date('2026-09-07T09:00:00Z');
  let prisma: any;
  let svc: DailyDigestService;

  /**
   * One store, TWO reads — the way the service reads it.
   *
   * The plan read is `orderBy updatedAt desc take 100`; the blocked read is its
   * own predicate (`resultRef startsWith 'skipped:'`, still-waiting statuses
   * only). Routing by the `where` rather than returning the same array to both
   * is the whole point: a mock that answers every findMany identically cannot
   * tell a report that survives a hundred fresh actions from one that does not.
   */
  const plan = (lane: string | null, actions: any[]) => {
    prisma.marketingStrategy.findUnique.mockResolvedValue(lane ? { autonomyLevel: lane } : null);
    prisma.strategyAction.findMany.mockImplementation(async ({ where, take }: any) => {
      const byRecency = [...actions].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
      if (where?.resultRef?.startsWith) {
        return byRecency
          .filter((a) => String(a.resultRef ?? '').startsWith(where.resultRef.startsWith))
          .filter((a) => where.status.in.includes(a.status))
          .slice(0, take);
      }
      return byRecency.slice(0, take);
    });
  };

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, name: 'HummyTummy' }) },
      lead: { count: jest.fn().mockResolvedValue(0) },
      message: { count: jest.fn().mockResolvedValue(0) },
      approvalRequest: { count: jest.fn().mockResolvedValue(0) },
      researchCandidate: { count: jest.fn().mockResolvedValue(0) },
      marketingTask: { count: jest.fn().mockResolvedValue(0) },
      workspaceMembership: { findMany: jest.fn() },
      marketingUser: { findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
      socialAccount: { count: jest.fn().mockResolvedValue(0) },
      scheduledJob: { count: jest.fn().mockResolvedValue(0) },
      adAccount: { count: jest.fn().mockResolvedValue(0) },
      socialCampaign: { count: jest.fn().mockResolvedValue(0) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
      growthBudget: { findFirst: jest.fn().mockResolvedValue(null) },
      marketingDistributionConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      marketingStrategy: { findUnique: jest.fn().mockResolvedValue(null) },
      strategyAction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    svc = new DailyDigestService(
      prisma,
      { breakdown: jest.fn().mockResolvedValue(null) } as never,
      { workspaceStatus: jest.fn().mockResolvedValue(null) } as never,
    );
  });

  it('carries BOTH halves: what ran, and what did not with the reason', async () => {
    plan('AUTONOMOUS', [
      { kind: 'CONTENT', title: 'Reels serisi', status: 'DONE', resultRef: 'post:p1', updatedAt: YESTERDAY },
      { kind: 'AD_CAMPAIGN', title: 'Retargeting', status: 'PROPOSED', resultRef: 'skipped:kill-switch', updatedAt: YESTERDAY },
      { kind: 'CONTENT', title: 'Blog serisi', status: 'PROPOSED', resultRef: 'skipped:kill-switch', updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.autopilot.items[0]).toContain('1 eylem uygulandı');
    expect(d.autopilot.items[0]).toContain('Reels serisi');
    const refused = d.autopilot.items.find((l) => l.includes('yapılmadı'))!;
    expect(refused).toContain('2 eylem yapılmadı');
    // The reason, in the owner's language, naming what would change it.
    expect(refused).toContain('harcama/yayın anahtarı kapalı');
    expect(refused).toContain('Retargeting');
  });

  it('reports a FAILED action with the executor\'s own reason, not a paraphrase', async () => {
    plan('AUTONOMOUS', [
      { kind: 'CONTENT', title: 'Reels serisi', status: 'FAILED', resultRef: 'error:no ad account connected', updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.autopilot.items).toEqual(['"Reels serisi" yapılamadı: no ad account connected']);
  });

  it('an armed lane that did NOTHING still sends — silence is the finding', async () => {
    // This is the one inversion of the digest's "stay quiet when nothing
    // happened" rule, and it is the whole point. The live workspace sat on nine
    // PROPOSED actions for weeks and no surface anywhere said a word.
    plan('AUTONOMOUS', [
      { kind: 'CONTENT', title: 'Reels serisi', status: 'PROPOSED', resultRef: null, updatedAt: LAST_WEEK },
      { kind: 'CONTENT', title: 'Blog serisi', status: 'PROPOSED', resultRef: null, updatedAt: LAST_WEEK },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.empty).toBe(false);
    expect(d.autopilot.items).toEqual([
      expect.stringContaining('2 eylem hâlâ bekliyor'),
    ]);
  });

  it('does not count yesterday-and-older executions as last night\'s work', async () => {
    plan('AUTONOMOUS', [
      { kind: 'CONTENT', title: 'Eski iş', status: 'DONE', resultRef: 'post:p0', updatedAt: LAST_WEEK },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.autopilot.items.join(' ')).not.toContain('uygulandı');
    expect(d.autopilot.items.join(' ')).toContain('uygulanacak eylem kalmadı');
  });

  it('stays silent for an approval-gated lane — that one already has a surface', async () => {
    // A daily "your autopilot is off" is a line that can never reach zero, and
    // a section full of those is a section people learn to skip.
    plan('ASSISTED', [
      { kind: 'CONTENT', title: 'Reels serisi', status: 'PROPOSED', resultRef: null, updatedAt: LAST_WEEK },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.autopilot.items).toEqual([]);
    expect(d.empty).toBe(true);
  });

  it('reports an unrecognised skip code rather than dropping it', async () => {
    plan('AUTONOMOUS', [
      { kind: 'CONTENT', title: 'Reels serisi', status: 'PROPOSED', resultRef: 'skipped:brand-new-reason', updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.autopilot.items[0]).toContain('brand-new-reason');
  });

  it('renders the autopilot block in the email body', async () => {
    plan('AUTONOMOUS', [
      { kind: 'CONTENT', title: 'Reels serisi', status: 'DONE', resultRef: 'post:p1', updatedAt: YESTERDAY },
    ]);
    const body = svc.render((await svc.build(WS, NOW))!);
    expect(body).toContain('Otopilot:');
    expect(body).toContain('Reels serisi');
  });

  /**
   * "What it did NOT do" is the half nothing else in the product can rebuild —
   * and it was the first half to disappear.
   *
   * The plan read is ordered by `updatedAt desc`, and the skip stamps are
   * deliberately conditional: a reason that has not changed is NOT rewritten, so
   * a blocked action's timestamp stays where it was while everything that ran
   * floats above it. Past a hundred lifetime actions the rows that fall out of
   * that window first are exactly the ones that have been blocked longest.
   */
  it('reports blocked actions that fell out of the recent-plan window entirely', async () => {
    const fresh = Array.from({ length: 120 }, (_, i) => ({
      kind: 'CONTENT',
      title: `Taze ${i}`,
      status: 'DONE',
      resultRef: `post:p${i}`,
      updatedAt: YESTERDAY,
    }));
    plan('AUTONOMOUS', [
      ...fresh,
      // Stamped weeks ago and never re-stamped, so it sorts below all 120.
      { kind: 'AD_CAMPAIGN', title: 'Retargeting', status: 'PROPOSED', resultRef: 'skipped:kill-switch', updatedAt: LAST_WEEK },
    ]);
    const d = (await svc.build(WS, NOW))!;
    const refused = d.autopilot.items.find((l) => l.includes('yapılmadı'));
    expect(refused).toBeDefined();
    expect(refused).toContain('Retargeting');
  });

  it('drops a DISMISSED action from the blocked list — declining it is what clears the line', async () => {
    // The stamp is never cleared, so without a status filter the owner's own
    // "no thanks" would keep reporting itself every morning, forever.
    plan('AUTONOMOUS', [
      { kind: 'CHANNEL_SETUP', title: 'Kanal kurulumu', status: 'DISMISSED', resultRef: 'skipped:no-executor', updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, MONDAY))!;
    expect(d.autopilot.items.join(' ')).not.toContain('Kanal kurulumu');
  });

  /**
   * A line the owner cannot clear is a line that teaches people to skip the
   * section — and `no-executor` is a fact about the PRODUCT (CHANNEL_SETUP has
   * no executor), identical every morning for as long as the action exists. It
   * still matters once: an action parked in an armed plan will never run. So it
   * reports weekly, and says the two things that close it.
   */
  it('does NOT repeat the no-executor line daily', async () => {
    plan('AUTONOMOUS', [
      { kind: 'CHANNEL_SETUP', title: 'Kanal kurulumu', status: 'APPROVED', resultRef: 'skipped:no-executor', updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, NOW))!; // NOW is a Wednesday
    expect(d.autopilot.items.join(' ')).not.toContain('yürütücü');
    expect(d.autopilot.items.join(' ')).not.toContain('Kanal kurulumu');
  });

  it('reports the no-executor actions once a week, naming what clears them', async () => {
    plan('AUTONOMOUS', [
      { kind: 'CHANNEL_SETUP', title: 'Kanal kurulumu', status: 'APPROVED', resultRef: 'skipped:no-executor', updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, MONDAY))!;
    const line = d.autopilot.items.find((l) => l.includes('Haftalık'))!;
    expect(line).toContain('Kanal kurulumu');
    expect(line).toContain('yürütücü');
    // The half that makes it reachable-zero: what the owner can actually do.
    expect(line).toContain('reddet');
  });

  it('still reports the daily skip reasons the owner CAN act on, every day', async () => {
    // The weekly rule is about one code, not about the section. A kill-switch
    // line clears the moment the switch is armed, so it belongs in the daily block.
    plan('AUTONOMOUS', [
      { kind: 'CONTENT', title: 'Blog serisi', status: 'PROPOSED', resultRef: 'skipped:kill-switch', updatedAt: YESTERDAY },
      { kind: 'CHANNEL_SETUP', title: 'Kanal kurulumu', status: 'APPROVED', resultRef: 'skipped:no-executor', updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.autopilot.items.join(' ')).toContain('harcama/yayın anahtarı kapalı');
    expect(d.autopilot.items.join(' ')).not.toContain('Kanal kurulumu');
  });
});

/**
 * "DONE" is not "did something".
 *
 * The content and community executors return `{ resultRef: undefined }` when
 * the Content AI is unconfigured; the ad executor does the same when no
 * connected Meta ad account exists. In every one of those cases the
 * orchestrator still records DONE. A brief that counts those as work applied
 * reports a success for an action that produced nothing — on exactly the
 * setups where nothing CAN be produced, which is the reading a self-running
 * system can least afford.
 */
describe('DailyDigestService — an action that ran but produced nothing', () => {
  const WS = 'ws-1';
  const NOW = new Date('2026-09-02T09:00:00Z');
  const YESTERDAY = new Date('2026-09-01T20:00:00Z');
  let prisma: any;
  let svc: DailyDigestService;

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: WS, name: 'HummyTummy' }) },
      lead: { count: jest.fn().mockResolvedValue(0) },
      message: { count: jest.fn().mockResolvedValue(0) },
      approvalRequest: { count: jest.fn().mockResolvedValue(0) },
      researchCandidate: { count: jest.fn().mockResolvedValue(0) },
      marketingTask: { count: jest.fn().mockResolvedValue(0) },
      workspaceMembership: { findMany: jest.fn() },
      marketingUser: { findMany: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
      socialAccount: { count: jest.fn().mockResolvedValue(0) },
      scheduledJob: { count: jest.fn().mockResolvedValue(0) },
      adAccount: { count: jest.fn().mockResolvedValue(0) },
      socialCampaign: { count: jest.fn().mockResolvedValue(0) },
      campaign: { count: jest.fn().mockResolvedValue(0) },
      growthBudget: { findFirst: jest.fn().mockResolvedValue(null) },
      marketingDistributionConfig: { findUnique: jest.fn().mockResolvedValue(null) },
      marketingStrategy: { findUnique: jest.fn().mockResolvedValue({ autonomyLevel: 'AUTONOMOUS' }) },
      strategyAction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    svc = new DailyDigestService(
      prisma,
      { breakdown: jest.fn().mockResolvedValue(null) } as never,
      { workspaceStatus: jest.fn().mockResolvedValue(null) } as never,
    );
  });

  it('does NOT report a DONE action with no resultRef as work applied', async () => {
    // The measured workspace's single AD_CAMPAIGN action, on a workspace with
    // no connected Meta ad account: the executor logs, returns nothing, and the
    // orchestrator stamps DONE with a null resultRef.
    prisma.strategyAction.findMany.mockResolvedValue([
      { kind: 'AD_CAMPAIGN', title: 'Retargeting', status: 'DONE', resultRef: null, updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.autopilot.items.join(' ')).not.toContain('eylem uygulandı');
    const line = d.autopilot.items.find((l) => l.includes('sonuç yok'))!;
    expect(line).toContain('1 eylem');
    expect(line).toContain('Retargeting');
  });

  it('still counts the ones that produced something, separately', async () => {
    prisma.strategyAction.findMany.mockResolvedValue([
      { kind: 'CONTENT', title: 'Reels serisi', status: 'DONE', resultRef: 'post:p1', updatedAt: YESTERDAY },
      { kind: 'AD_CAMPAIGN', title: 'Retargeting', status: 'DONE', resultRef: null, updatedAt: YESTERDAY },
    ]);
    const d = (await svc.build(WS, NOW))!;
    expect(d.autopilot.items[0]).toBe('1 eylem uygulandı: "Reels serisi"');
    expect(d.autopilot.items[1]).toContain('1 eylem çalıştı ama ortada bir sonuç yok');
    expect(d.autopilot.items[1]).toContain('Retargeting');
  });
});
