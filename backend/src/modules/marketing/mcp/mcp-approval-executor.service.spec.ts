import { BadRequestException, NotFoundException } from '@nestjs/common';
import { McpApprovalExecutorService } from './mcp-approval-executor.service';
import { APPLYING_HEARTBEAT_MS, ApprovalRequestService } from '../agents/approval-request.service';

/**
 * This executor is the "approve → EXECUTE" capstone for MCP write tools
 * (mirrors BudgetExecutorService for the reallocation lane). Coverage here
 * mirrors the money-safety posture: never execute a non-MCP payload (a
 * budget-autopilot approval must keep flowing through BudgetExecutorService),
 * never execute anything but an APPROVED request, never let two concurrent
 * callers both reach the broker, and never mark applied unless the tool
 * actually ran (and revert the claim, not strand it, when it doesn't).
 */
describe('McpApprovalExecutorService', () => {
  const WS = 'ws1';
  const APPROVAL = 'appr1';
  const USER = 'user1';
  const TOOL = 'jeeta.reallocate_budget';

  function make(overrides: { approval?: any } = {}) {
    const prisma = {
      approvalRequest: { findFirst: jest.fn().mockResolvedValue(overrides.approval ?? null) },
    };
    const approvals = {
      claimForApply: jest.fn().mockResolvedValue({ id: APPROVAL, status: 'APPLYING' }),
      finishApply: jest.fn().mockResolvedValue({ id: APPROVAL, status: 'APPLIED' }),
      revertApply: jest.fn().mockResolvedValue(undefined),
      touchApplying: jest.fn().mockResolvedValue(undefined),
    };
    const broker = { invoke: jest.fn().mockResolvedValue({ status: 'OK', result: { moved: 100 } }) };
    const runs = {
      track: jest.fn((_workspaceId: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => fn('run-1')),
    };
    const registry = { get: jest.fn().mockReturnValue({ name: TOOL, scopes: ['settings.manage'] }) };
    const svc = new McpApprovalExecutorService(prisma as any, approvals as any, broker as any, runs as any, registry as any);
    return { svc, prisma, approvals, broker, runs, registry };
  }

  const mcpApproval = (status = 'APPROVED', payload: any = { tool: TOOL, args: { amount: 100 } }) => ({
    id: APPROVAL,
    workspaceId: WS,
    kind: 'AD_SPEND',
    status,
    payload,
  });

  it('404s when the approval is missing', async () => {
    const { svc } = make({ approval: null });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes the lookup to the caller workspace (tenant isolation, not just existence)', async () => {
    const { svc, prisma } = make({ approval: null });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(NotFoundException);
    // A where-clause missing `workspaceId` (the cross-tenant bug) would still
    // satisfy a mock that unconditionally returns null, so assert the exact
    // shape queried rather than only the outcome.
    expect(prisma.approvalRequest.findFirst).toHaveBeenCalledWith({ where: { id: APPROVAL, workspaceId: WS } });
  });

  it('rejects a non-MCP payload (e.g. a budget-autopilot reallocation)', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval('APPROVED', { budgetId: 'b1', runId: 'r1', after: [] }) });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(approvals.claimForApply).not.toHaveBeenCalled();
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('rejects a PENDING request without reaching the broker', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval('PENDING') });
    approvals.claimForApply.mockRejectedValue(new BadRequestException('cannot apply a PENDING request'));
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('rejects a REJECTED request without reaching the broker', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval('REJECTED') });
    approvals.claimForApply.mockRejectedValue(new BadRequestException('cannot apply a REJECTED request'));
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('rejects an already-APPLIED request without reaching the broker', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval('APPLIED') });
    approvals.claimForApply.mockRejectedValue(new BadRequestException('cannot apply a APPLIED request'));
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('rejects an EXPIRED request without reaching the broker', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval('EXPIRED') });
    approvals.claimForApply.mockRejectedValue(new BadRequestException('cannot apply a EXPIRED request'));
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
  });

  it('claims BEFORE invoking the broker, and a losing concurrent claim never reaches the broker', async () => {
    // Simulates the loser of a real concurrent race: claimForApply's atomic
    // updateMany already reported zero rows claimed (another caller holds
    // APPLYING), so this call must never touch the tool.
    const { svc, broker, approvals } = make({ approval: mcpApproval() });
    approvals.claimForApply.mockRejectedValue(new BadRequestException('cannot apply a APPLYING request'));
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(broker.invoke).not.toHaveBeenCalled();
    expect(approvals.finishApply).not.toHaveBeenCalled();
  });

  it('executes the tool and finishes the claim (APPLYING -> APPLIED) on success', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval() });
    const out = await svc.apply(WS, APPROVAL, USER);
    expect(approvals.claimForApply).toHaveBeenCalledWith(WS, APPROVAL);
    expect(broker.invoke).toHaveBeenCalled();
    expect(approvals.finishApply).toHaveBeenCalledWith(WS, APPROVAL);
    expect(approvals.revertApply).not.toHaveBeenCalled();
    expect(out).toEqual({ status: 'APPLIED', result: { moved: 100 } });
  });

  it('carries approvedBy + requireAudit + the run-scoped agentRunId into the broker context', async () => {
    const { svc, broker } = make({ approval: mcpApproval() });
    await svc.apply(WS, APPROVAL, USER);
    expect(broker.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        agentRunId: 'run-1',
        requireAudit: true,
        approvedBy: { approvalId: APPROVAL, userId: USER },
      }),
      TOOL,
      { amount: 100 },
    );
  });

  it('opens the AgentRun under agent "mcp" with a goal naming the tool and the approval', async () => {
    const { svc, runs } = make({ approval: mcpApproval() });
    await svc.apply(WS, APPROVAL, USER);
    expect(runs.track).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ agent: 'mcp', goal: expect.stringContaining(TOOL) }),
      expect.any(Function),
    );
    const [, input] = runs.track.mock.calls[0];
    expect((input as { goal: string }).goal).toContain(APPROVAL);
  });

  it('grants the scopes the tool itself declares (the human already authorised this specific call)', async () => {
    const { svc, broker, registry } = make({ approval: mcpApproval() });
    registry.get.mockReturnValue({ name: TOOL, scopes: ['settings.manage', 'ads.write'] });
    await svc.apply(WS, APPROVAL, USER);
    expect(broker.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: ['settings.manage', 'ads.write'] }),
      TOOL,
      { amount: 100 },
    );
  });

  // H1 — reproduced by execution, not theorised: AgentRunService.track()
  // awaits its own post-execution `agent_runs` UPDATE (finish()) AFTER fn()
  // has already run the tool. The `runs.track` mock above (`fn => fn('run-1')`)
  // can never exercise that failure mode — it only ever calls fn() and
  // returns, never throws afterward. This test uses a mock that mirrors the
  // REAL AgentRunService.track shape: call fn(runId), and if it resolves,
  // throw (simulating finish() itself throwing) — and asserts the request
  // must NOT go back to APPROVED (which would let an operator re-click Apply
  // and re-send whatever the tool already sent).
  it('H1: a post-execution bookkeeping failure after the tool already ran finishes the claim (never reverts it)', async () => {
    const { svc, broker, approvals, runs } = make({ approval: mcpApproval() });
    runs.track.mockImplementation(async (_ws: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => {
      await fn('run-1'); // the tool call succeeds inside fn()
      throw new Error('agent_runs UPDATE failed (simulated DB failover)'); // finish() throws AFTER
    });

    const out = await svc.apply(WS, APPROVAL, USER);

    expect(broker.invoke).toHaveBeenCalledTimes(1); // the tool ran exactly once
    expect(approvals.revertApply).not.toHaveBeenCalled(); // MUST NOT go back to APPROVED
    expect(approvals.finishApply).toHaveBeenCalledWith(WS, APPROVAL); // finished instead
    expect(out).toEqual({ status: 'APPLIED', result: { moved: 100 } });
  });

  // Issue #152, the last hop of the same chain: finishApply is itself a DB
  // write. If it fails after the tool ran, propagating that error tells the
  // operator the ACTION failed — and the honest-looking retry re-sends. The
  // caller must be told the truth about the action; the bookkeeping failure
  // goes to the log, a channel with no Apply button on it.
  it('reports APPLIED even when recording the claim fails, because the tool already ran', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval() });
    approvals.finishApply.mockRejectedValue(new Error('db down (simulated, past all retries)'));

    const out = await svc.apply(WS, APPROVAL, USER);

    expect(out).toEqual({ status: 'APPLIED', result: { moved: 100 } });
    expect(broker.invoke).toHaveBeenCalledTimes(1); // ran exactly once
    expect(approvals.revertApply).not.toHaveBeenCalled(); // never back into the appliable queue
  });

  it('H1: a bookkeeping failure BEFORE the tool ran (broker.invoke itself throws) still reverts, same as any tool failure', async () => {
    const { svc, broker, approvals, runs } = make({ approval: mcpApproval() });
    broker.invoke.mockRejectedValue(new Error('provider rejected the write'));
    runs.track.mockImplementation(async (_ws: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => {
      try {
        return await fn('run-1');
      } catch (err) {
        throw err; // mirrors AgentRunService.track's real catch-and-rethrow
      }
    });

    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toThrow('provider rejected the write');
    expect(approvals.revertApply).toHaveBeenCalledWith(WS, APPROVAL);
    expect(approvals.finishApply).not.toHaveBeenCalled();
  });

  it('on tool failure, reverts the claim (APPLYING -> APPROVED, not stranded) and surfaces the error', async () => {
    const { svc, broker, approvals } = make({ approval: mcpApproval() });
    broker.invoke.mockRejectedValue(new Error('provider rejected the write'));
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toThrow('provider rejected the write');
    expect(approvals.revertApply).toHaveBeenCalledWith(WS, APPROVAL);
    expect(approvals.finishApply).not.toHaveBeenCalled();
  });

  it('reverts the claim and refuses to report APPLIED if the broker somehow does not return OK', async () => {
    const { svc, approvals, broker } = make({ approval: mcpApproval() });
    broker.invoke.mockResolvedValue({ status: 'PENDING_APPROVAL', approvalId: 'appr-2' });
    await expect(svc.apply(WS, APPROVAL, USER)).rejects.toBeInstanceOf(BadRequestException);
    expect(approvals.revertApply).toHaveBeenCalledWith(WS, APPROVAL);
    expect(approvals.finishApply).not.toHaveBeenCalled();
  });

  it('genuinely prevents double execution under real concurrency (real ApprovalRequestService + in-memory claim state)', async () => {
    // No mocked approvals here — a real ApprovalRequestService wired to a
    // fake prisma that enforces the same conditional-updateMany semantics a
    // real DB would (an UPDATE ... WHERE status = 'APPROVED' only ever wins
    // once). This is the actual regression scenario Important-1 called out:
    // execute-then-claim lets both concurrent callers reach the broker;
    // claim-then-execute must let only one.
    let status = 'APPROVED';
    const prisma = {
      approvalRequest: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id === APPROVAL && where.workspaceId === WS
            ? { id: APPROVAL, workspaceId: WS, status, payload: { tool: TOOL, args: { amount: 100 } } }
            : null,
        ),
        updateMany: jest.fn(async ({ where, data }: any) => {
          // Models both predicate shapes a real UPDATE ... WHERE takes:
          // `status = 'APPROVED'` (claimForApply) and
          // `status IN ('APPLYING','APPROVED')` (finishApply).
          const pred = where.status;
          const matches =
            pred === undefined
              ? true
              : Array.isArray(pred?.in)
                ? pred.in.includes(status)
                : pred === status;
          if (!matches) return { count: 0 };
          status = data.status;
          return { count: 1 };
        }),
      },
    };
    const approvals = new ApprovalRequestService(prisma as any);
    let brokerCalls = 0;
    const broker = {
      invoke: jest.fn(async () => {
        brokerCalls += 1;
        return { status: 'OK', result: { moved: 100 } };
      }),
    };
    const runs = { track: jest.fn((_ws: string, _input: unknown, fn: (runId: string) => Promise<unknown>) => fn('run-1')) };
    const registry = { get: jest.fn().mockReturnValue({ name: TOOL, scopes: [] }) };
    const svc = new McpApprovalExecutorService(prisma as any, approvals as any, broker as any, runs as any, registry as any);

    const results = await Promise.allSettled([svc.apply(WS, APPROVAL, USER), svc.apply(WS, APPROVAL, USER)]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
    expect(brokerCalls).toBe(1); // the tool ran exactly once, not twice
    expect(status).toBe('APPLIED');
  });

  // Fix round 1: a fixed APPLYING duration is not a valid staleness signal —
  // a multi-account/carousel publish can legitimately run well past any
  // fixed threshold. Liveness is proven with a heartbeat instead (touchApplying
  // on APPLYING_HEARTBEAT_MS cadence). These tests pin the timer's lifecycle:
  // it must run only while broker.invoke() is actually in flight, and must
  // stop on every exit path — never outlive the call it belongs to.
  describe('heartbeat while the tool call is in flight', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('touches the claim on APPLYING_HEARTBEAT_MS cadence, and stops once the tool succeeds', async () => {
      jest.useFakeTimers();
      const { svc, broker, approvals } = make({ approval: mcpApproval() });
      let resolveInvoke!: (v: unknown) => void;
      broker.invoke.mockReturnValue(new Promise((resolve) => { resolveInvoke = resolve; }));

      const applyPromise = svc.apply(WS, APPROVAL, USER);

      expect(approvals.touchApplying).not.toHaveBeenCalled(); // nothing before the first tick

      await jest.advanceTimersByTimeAsync(APPLYING_HEARTBEAT_MS);
      expect(approvals.touchApplying).toHaveBeenCalledTimes(1);
      expect(approvals.touchApplying).toHaveBeenCalledWith(WS, APPROVAL);

      await jest.advanceTimersByTimeAsync(APPLYING_HEARTBEAT_MS);
      expect(approvals.touchApplying).toHaveBeenCalledTimes(2);

      resolveInvoke({ status: 'OK', result: { ok: true } });
      await expect(applyPromise).resolves.toEqual({ status: 'APPLIED', result: { ok: true } });

      // No further ticks after the call finished — the timer must not
      // outlive the execution it belongs to.
      await jest.advanceTimersByTimeAsync(APPLYING_HEARTBEAT_MS * 5);
      expect(approvals.touchApplying).toHaveBeenCalledTimes(2);
    });

    it('stops the heartbeat when the tool call throws (and still reverts the claim)', async () => {
      jest.useFakeTimers();
      const { svc, broker, approvals } = make({ approval: mcpApproval() });
      let rejectInvoke!: (e: unknown) => void;
      broker.invoke.mockReturnValue(new Promise((_resolve, reject) => { rejectInvoke = reject; }));

      const applyPromise = svc.apply(WS, APPROVAL, USER);
      applyPromise.catch(() => {}); // observed below; avoids an unhandled-rejection warning during timer advances

      await jest.advanceTimersByTimeAsync(APPLYING_HEARTBEAT_MS);
      expect(approvals.touchApplying).toHaveBeenCalledTimes(1);

      rejectInvoke(new Error('provider rejected the write'));
      await expect(applyPromise).rejects.toThrow('provider rejected the write');
      expect(approvals.revertApply).toHaveBeenCalledWith(WS, APPROVAL);

      await jest.advanceTimersByTimeAsync(APPLYING_HEARTBEAT_MS * 5);
      expect(approvals.touchApplying).toHaveBeenCalledTimes(1); // no ticks after the throw
    });

    it('stops the heartbeat when the tool returns a non-OK status (and still reverts the claim)', async () => {
      jest.useFakeTimers();
      const { svc, broker, approvals } = make({ approval: mcpApproval() });
      let resolveInvoke!: (v: unknown) => void;
      broker.invoke.mockReturnValue(new Promise((resolve) => { resolveInvoke = resolve; }));

      const applyPromise = svc.apply(WS, APPROVAL, USER);
      applyPromise.catch(() => {});

      await jest.advanceTimersByTimeAsync(APPLYING_HEARTBEAT_MS);
      expect(approvals.touchApplying).toHaveBeenCalledTimes(1);

      resolveInvoke({ status: 'PENDING_APPROVAL', approvalId: 'appr-2' });
      await expect(applyPromise).rejects.toBeInstanceOf(BadRequestException);
      expect(approvals.revertApply).toHaveBeenCalledWith(WS, APPROVAL);

      await jest.advanceTimersByTimeAsync(APPLYING_HEARTBEAT_MS * 5);
      expect(approvals.touchApplying).toHaveBeenCalledTimes(1); // no ticks after the non-OK exit
    });

    it('a heartbeat write failure is swallowed (best-effort) and never aborts the in-flight call', async () => {
      jest.useFakeTimers();
      const { svc, broker, approvals } = make({ approval: mcpApproval() });
      approvals.touchApplying.mockRejectedValue(new Error('db blip'));
      let resolveInvoke!: (v: unknown) => void;
      broker.invoke.mockReturnValue(new Promise((resolve) => { resolveInvoke = resolve; }));

      const applyPromise = svc.apply(WS, APPROVAL, USER);

      await jest.advanceTimersByTimeAsync(APPLYING_HEARTBEAT_MS);
      expect(approvals.touchApplying).toHaveBeenCalledTimes(1);

      resolveInvoke({ status: 'OK', result: { ok: true } });
      await expect(applyPromise).resolves.toEqual({ status: 'APPLIED', result: { ok: true } });
    });
  });
});
