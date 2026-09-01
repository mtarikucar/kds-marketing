import 'reflect-metadata';
import { ConflictException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StrategyController } from './strategy.controller';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MARKETING_ROLES_KEY } from '../decorators/marketing-roles.decorator';
import { REQUIRE_PERMISSION_KEY } from '../roles/require-permission.decorator';
import { AUDIT_METADATA } from '../../audit/audit.decorator';

/**
 * POST /marketing/strategy/refresh — the panel's only way to ask for a new
 * strategy + ActionPlan.
 *
 * The route matters far more than its two lines suggest: a refresh DELETES the
 * entire current ActionPlan (persist() drops every StrategyAction for the
 * strategy regardless of status, DONE and FAILED rows and their `resultRef`s
 * included) and spends a bounded Opus tool-loop's worth of credits plus live
 * crawl money doing it. So the things worth pinning are the ones that would let
 * the wrong person, or an unaudited request, trigger that: the role floor, the
 * permission, the audit record, and the fact that the workspace comes from the
 * authenticated caller and nowhere else.
 *
 * Follows marketing-workspaces.controller.spec.ts: read the decorator metadata
 * straight off the prototype (no DI, no HTTP harness), then feed that SAME
 * metadata through the REAL MarketingRolesGuard, so "a non-manager is rejected"
 * is proven against the guard's actual hierarchy rather than asserted in the
 * abstract.
 */
function meta(key: string, method: string): any {
  return Reflect.getMetadata(
    key,
    (StrategyController.prototype as Record<string, unknown>)[method] as object,
  );
}

function ctxFor(handler: (...args: unknown[]) => unknown, role?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ marketingUser: role ? { role } : undefined }),
    }),
    getHandler: () => handler,
    getClass: () => StrategyController,
  } as unknown as ExecutionContext;
}

/**
 * A Prisma double whose ONLY job is the refresh lock.
 *
 * `refresh` now runs inside `prisma.$transaction`, taking a per-workspace
 * `pg_try_advisory_xact_lock` before it delegates. `granted: false` is the
 * second concurrent caller — the lock is held by a run already in flight.
 */
function makePrisma(granted = true) {
  const queryRawUnsafe = jest.fn().mockResolvedValue([{ locked: granted }]);
  const $transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRawUnsafe: queryRawUnsafe }),
  );
  return { $transaction, queryRawUnsafe } as any;
}

function makeController(feedback: { refresh: jest.Mock }, prisma = makePrisma()) {
  const strategy = {
    getStrategy: jest.fn(),
    listActions: jest.fn(),
    approveAction: jest.fn(),
    dismissAction: jest.fn(),
    setAutonomy: jest.fn(),
  } as any;
  return { ctrl: new StrategyController(strategy, feedback as any, prisma), strategy, prisma };
}

describe('StrategyController.refresh', () => {
  it("delegates to StrategyFeedbackService.refresh with the CALLER'S workspace", async () => {
    const feedback = { refresh: jest.fn().mockResolvedValue({ strategyId: 'st-1', actionCount: 6 }) };
    const { ctrl } = makeController(feedback);

    const out = await ctrl.refresh({ id: 'u-1', workspaceId: 'ws-1' } as any);

    expect(feedback.refresh).toHaveBeenCalledWith('ws-1');
    expect(feedback.refresh).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ strategyId: 'st-1', actionCount: 6 });
  });

  it('takes the workspace ONLY from the authenticated payload — there is no body or param to spoof', async () => {
    const feedback = { refresh: jest.fn().mockResolvedValue({ strategyId: null, actionCount: 0 }) };
    const { ctrl } = makeController(feedback);

    // Two different callers, two different workspaces, one argument each:
    // nothing else a request carries can redirect a destructive re-synthesis at
    // somebody else's strategy.
    await ctrl.refresh({ id: 'u-1', workspaceId: 'ws-1' } as any);
    await ctrl.refresh({ id: 'u-2', workspaceId: 'ws-2' } as any);

    expect(feedback.refresh.mock.calls).toEqual([['ws-1'], ['ws-2']]);
    expect(ctrl.refresh.length).toBe(1);
  });

  it('passes the feedback service result straight through, including the no-op skip shapes', async () => {
    // A workspace that never completed onboarding has no ACTIVE strategy (or no
    // intake session to re-synthesize from). refresh() answers `{ skipped }`
    // rather than throwing, and the route must not dress that up as success or
    // as a 500 — the console renders the reason.
    const feedback = {
      refresh: jest
        .fn()
        .mockResolvedValue({ strategyId: null, actionCount: 0, skipped: 'no-active-strategy' }),
    };
    const { ctrl } = makeController(feedback);

    await expect(ctrl.refresh({ workspaceId: 'ws-9' } as any)).resolves.toEqual({
      strategyId: null,
      actionCount: 0,
      skipped: 'no-active-strategy',
    });
  });

  it('does not touch StrategyService — nothing may write the strategy or its actions after the refresh', async () => {
    // persist() ends by touching MarketingStrategy LAST so it stays newer than
    // the actions it just seeded; the weekly cron's skip gate is exactly that
    // comparison. Any extra write from this handler (a status stamp, an action
    // touch) would invert the ordering and put a full Opus re-synthesis on every
    // ACTIVE workspace every week. Assert the handler is inert beyond delegating.
    const feedback = { refresh: jest.fn().mockResolvedValue({ strategyId: 'st-1', actionCount: 3 }) };
    const { ctrl, strategy } = makeController(feedback);

    await ctrl.refresh({ workspaceId: 'ws-1' } as any);

    for (const fn of Object.values(strategy) as jest.Mock[]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  /**
   * ONE REFRESH AT A TIME, PER WORKSPACE.
   *
   * Everything above describes a single run in isolation. Two overlapping runs
   * break it from a direction no care inside the handler can close: persist()
   * is upsert → deleteMany → createMany → update, so interleaving leaves BOTH
   * plans under one strategy (duplicated ideas, up to 48 actions against a cap
   * of 24), and if run A's closing `marketingStrategy.update` lands before run
   * B's createMany the strategy row ends up OLDER than its own actions —
   * exactly the inversion the route's comment (b) exists to prevent, which
   * re-opens the weekly cron's skip gate and buys an extra billed Opus
   * re-synthesis every week for every ACTIVE workspace.
   *
   * A double-click is the normal way this happens: the run is awaited for up to
   * MAX_WALL_MS (180s by default) and the button gives no feedback for minutes.
   */
  describe('serialization', () => {
    it('takes a per-WORKSPACE advisory lock before doing anything expensive', async () => {
      const feedback = { refresh: jest.fn().mockResolvedValue({ strategyId: 'st-1', actionCount: 4 }) };
      const { ctrl, prisma } = makeController(feedback);

      await ctrl.refresh({ workspaceId: 'ws-1' } as any);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const sql = String(prisma.queryRawUnsafe.mock.calls[0][0]);
      // try_, not the blocking variant — see the 409 test below for why.
      expect(sql).toContain('pg_try_advisory_xact_lock');
      // Namespaced and scoped to the workspace, so one workspace's refresh
      // never blocks another's.
      expect(sql).toContain("'strategy-refresh:ws-1'");
    });

    it('refuses a second concurrent refresh with 409 instead of queueing behind a 3-minute run', async () => {
      // The blocking `pg_advisory_xact_lock` would make the impatient second
      // click WAIT and then run a second full-price synthesis the moment the
      // first finished — immediately wiping the plan it had just paid for.
      // Failing fast says the true thing and costs nothing.
      const feedback = { refresh: jest.fn() };
      const { ctrl } = makeController(feedback, makePrisma(false));

      await expect(ctrl.refresh({ workspaceId: 'ws-1' } as any)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // And crucially: not a single credit spent, not a single action deleted.
      expect(feedback.refresh).not.toHaveBeenCalled();
    });

    it('carries a machine-readable code on the 409 so the console can say WHY', async () => {
      const { ctrl } = makeController({ refresh: jest.fn() }, makePrisma(false));

      await expect(ctrl.refresh({ workspaceId: 'ws-1' } as any)).rejects.toMatchObject({
        response: { code: 'STRATEGY_REFRESH_IN_PROGRESS' },
      });
    });

    it('does the work INSIDE the lock, not after it', async () => {
      // A lock taken and released before the run serializes nothing. Pin the
      // ordering: the transaction callback must still be on the stack when
      // feedback.refresh() is called.
      let insideTransaction = false;
      const feedback = {
        refresh: jest.fn(async () => {
          expect(insideTransaction).toBe(true);
          return { strategyId: 'st-1', actionCount: 1 };
        }),
      };
      const prisma = {
        $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
          insideTransaction = true;
          try {
            return await fn({ $queryRawUnsafe: jest.fn().mockResolvedValue([{ locked: true }]) });
          } finally {
            insideTransaction = false;
          }
        }),
      } as any;
      const { ctrl } = makeController(feedback, prisma);

      await ctrl.refresh({ workspaceId: 'ws-1' } as any);
      expect(feedback.refresh).toHaveBeenCalledTimes(1);
    });

    it('gives the lock transaction a timeout that outlives the synthesis it is protecting', async () => {
      // Synthesis is bounded by STRATEGY_SYNTH_MAX_MS (180s by default). A
      // transaction timeout shorter than that would tear the lock down MID-RUN
      // — releasing it to a second caller while the first is still writing,
      // which is precisely the interleaving this lock exists to prevent.
      const { ctrl, prisma } = makeController({
        refresh: jest.fn().mockResolvedValue({ strategyId: 'st-1', actionCount: 1 }),
      });

      await ctrl.refresh({ workspaceId: 'ws-1' } as any);

      const opts = prisma.$transaction.mock.calls[0][1];
      expect(opts.timeout).toBeGreaterThan(Number(process.env.STRATEGY_SYNTH_MAX_MS ?? 180_000));
    });
  });

  describe('guard stack', () => {
    it("is gated on MANAGER + settings.manage, matching the plan's other write routes", () => {
      expect(meta(MARKETING_ROLES_KEY, 'refresh')).toEqual(['MANAGER']);
      expect(meta(REQUIRE_PERMISSION_KEY, 'refresh')).toBe('settings.manage');
      // Same floor as approve/dismiss/autonomy: deciding what the engine may
      // execute and replacing what it is allowed to execute are the same
      // authority.
      expect(meta(MARKETING_ROLES_KEY, 'approve')).toEqual(['MANAGER']);
      expect(meta(MARKETING_ROLES_KEY, 'setAutonomy')).toEqual(['MANAGER']);
    });

    it('the real MarketingRolesGuard refuses REP and SYSTEM, and admits MANAGER/OWNER', () => {
      const guard = new MarketingRolesGuard(new Reflector());
      const handler = (StrategyController.prototype as Record<string, any>).refresh;

      for (const role of ['REP', 'SYSTEM']) {
        expect(() => guard.canActivate(ctxFor(handler, role))).toThrow(ForbiddenException);
      }
      // An unauthenticated request never gets as far as having a role.
      expect(() => guard.canActivate(ctxFor(handler))).toThrow(ForbiddenException);
      // OWNER outranks MANAGER in this codebase's hierarchical guard, so the
      // single-role listing admits it without being spelled out.
      expect(guard.canActivate(ctxFor(handler, 'MANAGER'))).toBe(true);
      expect(guard.canActivate(ctxFor(handler, 'OWNER'))).toBe(true);
    });

    it('is audited under a stable action name against the strategy resource', () => {
      // A destructive, money-spending operator gesture has to leave a row: the
      // audit log is the only thing that later answers "who wiped the plan?".
      expect(meta(AUDIT_METADATA, 'refresh')).toMatchObject({
        action: 'strategy.refresh',
        resourceType: 'marketing_strategy',
      });
    });

    it('carries a burst cap — the credit meter is unbounded on an unlimited plan', () => {
      // A refresh is the single most expensive call in the product: a bounded
      // Opus tool-loop over live research, billed as one `strategy.synthesize`
      // reserve plus a `strategy.turn` per turn, on top of firecrawl/apify money
      // against the RESEARCH budget. On a -1 (unlimited) plan the credit meter
      // imposes no ceiling at all, which is exactly why /ai/compose (limit 10)
      // and /ai/command (limit 6) already carry this decorator with the same
      // reasoning written next to them. Without it this route inherits only the
      // global 300/60s envelope — three hundred Opus re-syntheses a minute.
      //
      // `@Throttle({ default: { … } })` writes one metadata key per FIELD, each
      // suffixed with the named-throttler it belongs to — so the keys read
      // 'THROTTLER:LIMIT' + 'default'. Spelled out rather than imported from the
      // package's internals so this test keeps failing usefully if a version
      // bump changes the shape, instead of silently asserting nothing.
      expect(meta('THROTTLER:LIMITdefault', 'refresh')).toBe(2);
      expect(meta('THROTTLER:TTLdefault', 'refresh')).toBe(60_000);
    });

    it('leaves the READ routes on reports.read — the new write route did not widen them', () => {
      expect(meta(REQUIRE_PERMISSION_KEY, 'getStrategy')).toBe('reports.read');
      expect(meta(REQUIRE_PERMISSION_KEY, 'listActions')).toBe('reports.read');
      expect(meta(MARKETING_ROLES_KEY, 'getStrategy')).toBeUndefined();
    });
  });
});
