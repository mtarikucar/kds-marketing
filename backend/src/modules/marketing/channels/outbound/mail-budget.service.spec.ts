import { MailBudgetService, MAIL_DAILY_METRIC, PLATFORM_SENTINEL, mailDayKey } from './mail-budget.service';

/**
 * The daily budget on the shared platform relay (`shared-godaddy-mailbox`,
 * `no-per-tenant-control`).
 *
 * One GoDaddy mailbox carries every tenant's fallback bulk, workflow and
 * transactional mail. Nothing counted it and nothing capped it, so one
 * tenant's blast could trip the relay's own daily limit and take password
 * resets, invoices and booking confirmations down for every other tenant that
 * day — with no way for the operator to tell whose blast it was.
 */
describe('MailBudgetService', () => {
  const WS = 'ws-1';
  const NOON = new Date('2026-09-22T12:00:00.000Z');

  let prisma: any;
  let counters: Map<string, number>;

  function newService(env: Record<string, string | undefined> = {}): MailBudgetService {
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as any;
    return new MailBudgetService(prisma as any, config);
  }

  const key = (workspaceId: string, periodKey: string) => `${workspaceId}|${periodKey}`;

  beforeEach(() => {
    counters = new Map();
    prisma = {
      usageCounter: {
        findUnique: jest.fn(async (args: any) => {
          const w = args.where.workspaceId_metric_periodKey;
          const v = counters.get(key(w.workspaceId, w.periodKey));
          return v === undefined ? null : { value: v };
        }),
        findMany: jest.fn(async (args: any) => {
          const ids: string[] = args.where.workspaceId?.in ?? [];
          return ids
            .map((id) => ({ workspaceId: id, value: counters.get(key(id, args.where.periodKey)) ?? 0 }))
            .filter((r) => r.value > 0);
        }),
        upsert: jest.fn(async (args: any) => {
          const w = args.where.workspaceId_metric_periodKey;
          const k = key(w.workspaceId, w.periodKey);
          const before = counters.get(k);
          const next =
            before === undefined
              ? args.create.value
              : before + (args.update?.value?.increment ?? 0);
          counters.set(k, next);
          return { value: next };
        }),
        update: jest.fn(async (args: any) => {
          const w = args.where.workspaceId_metric_periodKey;
          counters.set(key(w.workspaceId, w.periodKey), args.data.value);
          return { value: args.data.value };
        }),
      },
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: '' }]),
      // The refund's guarded decrement. Positional, matching the one statement
      // the service issues: `GREATEST(0, value - $1) WHERE workspaceId = $2 AND
      // metric = $3 AND periodKey = $4`. Applied in one step on purpose —
      // that atomicity is the property under test below.
      $executeRaw: jest.fn(
        async (_sql: any, count: number, workspaceId: string, _metric: string, periodKey: string) => {
          const k = key(workspaceId, periodKey);
          const before = counters.get(k);
          if (before === undefined) return 0; // no row → the WHERE matched nothing
          counters.set(k, Math.max(0, before - count));
          return 1;
        },
      ),
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
  });

  it('counts a platform send against the workspace AND the platform row', async () => {
    const svc = newService();
    const refusal = await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    expect(refusal).toBeNull();
    expect(counters.get(key(WS, '2026-09-22'))).toBe(1);
    expect(counters.get(key(PLATFORM_SENTINEL, '2026-09-22'))).toBe(1);
  });

  it('never counts a tenant that sends through its OWN mailbox — that spends its own reputation', async () => {
    const svc = newService();
    for (const transport of ['MAILBOX_SMTP', 'MAILBOX_OAUTH', 'NONE'] as const) {
      expect(await svc.reserveDaily({ workspaceId: WS, transport, now: NOON })).toBeNull();
    }
    expect(counters.size).toBe(0);
    expect(prisma.usageCounter.upsert).not.toHaveBeenCalled();
  });

  it('refuses at the per-workspace cap, retriable at the next UTC midnight', async () => {
    const svc = newService({ MAIL_DAILY_CAP_WORKSPACE: '2' });
    await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });

    const refusal = await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    expect(refusal).toMatchObject({ scope: 'WORKSPACE', limit: 2, used: 2 });
    expect(refusal!.retryAt.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    // A refusal spends nothing — neither counter moved.
    expect(counters.get(key(WS, '2026-09-22'))).toBe(2);
    expect(counters.get(key(PLATFORM_SENTINEL, '2026-09-22'))).toBe(2);
  });

  it('refuses at the platform cap even when the workspace is nowhere near its own', async () => {
    const svc = newService({ MAIL_DAILY_CAP_WORKSPACE: '100', MAIL_DAILY_CAP_PLATFORM: '1' });
    await svc.reserveDaily({ workspaceId: 'ws-a', transport: 'PLATFORM', now: NOON });

    const refusal = await svc.reserveDaily({ workspaceId: 'ws-b', transport: 'PLATFORM', now: NOON });
    expect(refusal).toMatchObject({ scope: 'PLATFORM', limit: 1 });
    expect(counters.get(key('ws-b', '2026-09-22'))).toBeUndefined();
  });

  it('takes the platform lock before the workspace lock, so two tenants cannot deadlock', async () => {
    const svc = newService({ MAIL_DAILY_CAP_WORKSPACE: '10' });
    await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    const locks = prisma.$queryRawUnsafe.mock.calls.map(([s]: [string]) => s);
    expect(locks).toHaveLength(2);
    expect(locks[0]).toContain(`mail-daily:${PLATFORM_SENTINEL}`);
    expect(locks[1]).toContain(`mail-daily:${WS}`);
  });

  it('counts without capping when both caps are switched off, so the operator still gets attribution', async () => {
    const svc = newService({ MAIL_DAILY_CAP_WORKSPACE: '0', MAIL_DAILY_CAP_PLATFORM: '0' });
    for (let i = 0; i < 5; i++) {
      expect(await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON })).toBeNull();
    }
    expect(counters.get(key(WS, '2026-09-22'))).toBe(5);
    expect(counters.get(key(PLATFORM_SENTINEL, '2026-09-22'))).toBe(5);
    // Nothing to serialize when nothing can be refused.
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('refunds a send that never left, on both rows, and floors at zero', async () => {
    const svc = newService();
    await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    await svc.refundDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    expect(counters.get(key(WS, '2026-09-22'))).toBe(0);
    expect(counters.get(key(PLATFORM_SENTINEL, '2026-09-22'))).toBe(0);

    await svc.refundDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    expect(counters.get(key(WS, '2026-09-22'))).toBe(0);
  });

  it('refunds nothing for a mailbox send, because nothing was reserved', async () => {
    const svc = newService();
    await svc.refundDaily({ workspaceId: WS, transport: 'MAILBOX_SMTP', now: NOON });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.usageCounter.update).not.toHaveBeenCalled();
  });

  it('gives back without clobbering a send another tenant reserved at the same moment', async () => {
    // `__platform__` is ONE row that every tenant on the shared relay writes,
    // and a refund happens on every failed dispatch — which is exactly when a
    // relay is in trouble and several tenants are failing at once. Read the
    // value, subtract in JS, write the absolute number back, and the increment
    // that committed in between is gone: the counter reads LOW, so the
    // platform cap admits more than its limit and the operator console
    // under-reports the blast it exists to reveal. (The other direction —
    // refund racing refund — over-states the row instead and defers other
    // tenants' transactional mail with a spurious DAILY_CAP until midnight.)
    const svc = newService();
    counters.set(key(WS, '2026-09-22'), 1);
    counters.set(key(PLATFORM_SENTINEL, '2026-09-22'), 2);

    // Another tenant's send lands between this refund's read and its write.
    // Hooked on whichever call the refund makes for the sentinel row, so the
    // case holds whether the refund reads first or decrements in one step.
    let interleaved = false;
    const concurrentReserve = async (workspaceId: string) => {
      if (interleaved || workspaceId !== PLATFORM_SENTINEL) return;
      interleaved = true; // set BEFORE the await: the reserve reads this row too
      await svc.reserveDaily({ workspaceId: 'ws-2', transport: 'PLATFORM', now: NOON });
    };
    const findUnique = prisma.usageCounter.findUnique;
    prisma.usageCounter.findUnique = jest.fn(async (args: any) => {
      const row = await findUnique(args);
      await concurrentReserve(args.where.workspaceId_metric_periodKey.workspaceId);
      return row;
    });
    const executeRaw = prisma.$executeRaw;
    prisma.$executeRaw = jest.fn(async (sql: any, ...values: any[]) => {
      await concurrentReserve(values[1]);
      return executeRaw(sql, ...values);
    });

    await svc.refundDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });

    expect(interleaved).toBe(true); // the race really was exercised
    // 2 spent, +1 by the other tenant, −1 given back = 2.
    expect(counters.get(key(PLATFORM_SENTINEL, '2026-09-22'))).toBe(2);
    expect(counters.get(key(WS, '2026-09-22'))).toBe(0);
  });

  it('rolls over at UTC midnight — yesterday\'s blast does not hold today hostage', async () => {
    const svc = newService({ MAIL_DAILY_CAP_WORKSPACE: '1' });
    await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    expect(await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON })).not.toBeNull();

    const tomorrow = new Date('2026-09-23T00:00:01.000Z');
    expect(await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: tomorrow })).toBeNull();
    expect(counters.get(key(WS, '2026-09-23'))).toBe(1);
  });

  it('never throws: a counter that will not write is logged, and the mail goes', async () => {
    const svc = newService();
    prisma.$transaction.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON })).resolves.toBeNull();

    // The refund's own statement, not a neighbouring mock: a write that will
    // not land must stay a warning, or a bookkeeping failure becomes an
    // undelivered invoice.
    prisma.$executeRaw.mockRejectedValueOnce(new Error('gone'));
    await expect(svc.refundDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON })).resolves.toBeUndefined();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2); // and the second row still got its refund
  });

  it('reports one workspace\'s day without ever showing it the platform row', async () => {
    const svc = newService({ MAIL_DAILY_CAP_WORKSPACE: '50' });
    await svc.reserveDaily({ workspaceId: WS, transport: 'PLATFORM', now: NOON });
    await svc.reserveDaily({ workspaceId: 'ws-2', transport: 'PLATFORM', now: NOON });

    const usage = await svc.usage(WS, NOON);
    expect(usage).toMatchObject({ day: '2026-09-22', limit: 50, used: 1, remaining: 49 });
    expect(usage).not.toHaveProperty('platform');
  });

  it('EXCLUDES the sentinel from a per-workspace breakdown — it is not a tenant', async () => {
    const svc = newService();
    await svc.reserveDaily({ workspaceId: 'ws-a', transport: 'PLATFORM', now: NOON });
    await svc.reserveDaily({ workspaceId: 'ws-b', transport: 'PLATFORM', now: NOON });
    await svc.reserveDaily({ workspaceId: 'ws-b', transport: 'PLATFORM', now: NOON });

    const rows = await svc.breakdown(['ws-a', 'ws-b', PLATFORM_SENTINEL], NOON);
    expect(rows).toEqual([
      { workspaceId: 'ws-b', used: 2 },
      { workspaceId: 'ws-a', used: 1 },
    ]);
    const asked = prisma.usageCounter.findMany.mock.calls[0][0].where.workspaceId.in;
    expect(asked).not.toContain(PLATFORM_SENTINEL);
  });

  it('pins the metric name and the sentinel, which every usage read must exclude', () => {
    expect(MAIL_DAILY_METRIC).toBe('mail.platform.daily');
    expect(PLATFORM_SENTINEL).toBe('__platform__');
    // Not a uuid, so it can never collide with a real workspace id.
    expect(PLATFORM_SENTINEL).not.toMatch(/^[0-9a-f-]{36}$/i);
    expect(mailDayKey(NOON)).toBe('2026-09-22');
  });
});
