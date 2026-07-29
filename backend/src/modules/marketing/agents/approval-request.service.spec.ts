import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApprovalRequestService } from './approval-request.service';

function makePrisma(found: any = { id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null }) {
  const update = jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'a1', ...data }));
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    approvalRequest: {
      create: jest.fn().mockResolvedValue({ id: 'a1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(found),
      update,
      updateMany,
    },
  } as any;
  return { prisma, update, updateMany };
}

describe('ApprovalRequestService', () => {
  it('enqueues a request with kind/summary/payload', async () => {
    const { prisma } = makePrisma();
    const svc = new ApprovalRequestService(prisma);
    await svc.enqueue('ws1', { kind: 'BUDGET_REALLOCATION', summary: 'move 200 to META', payload: { after: [] } });
    expect(prisma.approvalRequest.create.mock.calls[0][0].data).toMatchObject({
      workspaceId: 'ws1', kind: 'BUDGET_REALLOCATION', summary: 'move 200 to META',
    });
  });

  // Task 7 fix round 1: an APPROVED-but-unapplied MCP request must stay
  // visible so an operator can retry apply — a PENDING-only filter made it
  // vanish the instant approve() succeeded and apply() had not run yet.
  it('listPending includes both PENDING and APPROVED (not REJECTED/EXPIRED/APPLYING/APPLIED)', async () => {
    const { prisma } = makePrisma();
    const svc = new ApprovalRequestService(prisma);
    await svc.listPending('ws1');
    const call = prisma.approvalRequest.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ workspaceId: 'ws1', status: { in: ['PENDING', 'APPROVED'] } });
  });

  it('approves a pending request via an ATOMIC conditional claim (single winner)', async () => {
    const { prisma, updateMany } = makePrisma();
    const svc = new ApprovalRequestService(prisma);
    await svc.approve('ws1', 'a1', 'user-9');
    // The decision write itself carries the PENDING predicate — two concurrent
    // decisions can never both land (the old read-check-then-update could).
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'PENDING' });
    expect(call.data).toMatchObject({ status: 'APPROVED', decidedById: 'user-9' });
    expect(call.data.decidedAt).toBeInstanceOf(Date);
  });

  it('rejects double-decision (claim matches 0 rows → already decided, never overwritten)', async () => {
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED', expiresAt: null });
    updateMany.mockResolvedValue({ count: 0 }); // the PENDING predicate matches nothing
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.approve('ws1', 'a1', 'u')).rejects.toThrow(/already APPROVED/);
  });

  it('a CONCURRENT loser (read PENDING, lost the claim race) gets already-decided instead of overwriting', async () => {
    // The read still sees PENDING, but the conditional write finds the row
    // already claimed by the racer — the exact TOCTOU the old code lost:
    // a late REJECTED could overwrite an APPROVED (and even APPLIED) request
    // whose budget change had already been pushed live to the ad platform.
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null });
    updateMany.mockResolvedValue({ count: 0 });
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.reject('ws1', 'a1', 'u')).rejects.toBeInstanceOf(BadRequestException);
    // And the only write attempted was the guarded claim — no unconditional update.
    expect(prisma.approvalRequest.update).not.toHaveBeenCalled();
  });

  it('expires a past-due request instead of approving it (guarded flip, PENDING-only)', async () => {
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: new Date(Date.now() - 1000) });
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.approve('ws1', 'a1', 'u')).rejects.toThrow(/expired/);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'PENDING' });
    expect(call.data).toEqual({ status: 'EXPIRED' });
  });

  it('404s a request from another workspace', async () => {
    const { prisma } = makePrisma(null);
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.reject('ws1', 'a-other', 'u')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only applies an APPROVED request (conditional claim on APPROVED)', async () => {
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null });
    updateMany.mockResolvedValue({ count: 0 }); // APPROVED predicate matches nothing
    const svc = new ApprovalRequestService(prisma);
    await expect(svc.markApplied('ws1', 'a1')).rejects.toThrow(/cannot apply a PENDING/);
  });

  it('markApplied claims APPROVED→APPLIED atomically', async () => {
    const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED', expiresAt: null });
    const svc = new ApprovalRequestService(prisma);
    await svc.markApplied('ws1', 'a1');
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED' });
    expect(call.data).toMatchObject({ status: 'APPLIED' });
    expect(call.data.appliedAt).toBeInstanceOf(Date);
  });

  // claimForApply / finishApply / revertApply: the claim-first execution
  // guard for executors whose side effect is NOT itself idempotent (an MCP
  // tool call). Distinct from markApplied above, which stays an
  // execute-then-mark contract for BudgetExecutorService's idempotent
  // internal-plan commit and must not change.
  describe('claimForApply / finishApply / revertApply', () => {
    it('claimForApply claims APPROVED→APPLYING atomically', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED', expiresAt: null });
      const svc = new ApprovalRequestService(prisma);
      await svc.claimForApply('ws1', 'a1');
      const call = updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        id: 'a1',
        workspaceId: 'ws1',
        status: 'APPROVED',
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      });
      expect(call.data).toEqual({ status: 'APPLYING' });
    });

    it('claimForApply rejects (and flips to EXPIRED) an APPROVED request past its own expiresAt', async () => {
      // approve() already refuses to APPROVE a stale PENDING request, but
      // approve and apply are two separate calls (see the class docblock) —
      // this covers the row that WAS approved in time and then sat un-applied
      // long enough to cross expiresAt before Apply was ever clicked.
      const { prisma, updateMany } = makePrisma({
        id: 'a1',
        workspaceId: 'ws1',
        status: 'APPROVED',
        expiresAt: new Date(Date.now() - 1000),
      });
      updateMany.mockResolvedValueOnce({ count: 0 }); // the expiresAt predicate excludes it
      const svc = new ApprovalRequestService(prisma);
      await expect(svc.claimForApply('ws1', 'a1')).rejects.toThrow(/expired/);
      // The follow-up guarded flip to EXPIRED only ever targets a still-APPROVED row.
      const flip = updateMany.mock.calls[1][0];
      expect(flip.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED' });
      expect(flip.data).toEqual({ status: 'EXPIRED' });
    });

    it('claimForApply claims a still-live APPROVED request with no expiresAt (unaffected)', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED', expiresAt: null });
      const svc = new ApprovalRequestService(prisma);
      await svc.claimForApply('ws1', 'a1');
      expect(updateMany).toHaveBeenCalledTimes(1); // no follow-up expiry flip needed
    });

    it('claimForApply rejects a non-APPROVED request without executing anything (0 rows claimed)', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'PENDING', expiresAt: null });
      updateMany.mockResolvedValue({ count: 0 });
      const svc = new ApprovalRequestService(prisma);
      await expect(svc.claimForApply('ws1', 'a1')).rejects.toThrow(/cannot apply a PENDING/);
    });

    it('claimForApply rejects a concurrent loser (row already APPLYING) the same way — 0 rows claimed', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPLYING', expiresAt: null });
      updateMany.mockResolvedValue({ count: 0 }); // the APPROVED predicate no longer matches
      const svc = new ApprovalRequestService(prisma);
      await expect(svc.claimForApply('ws1', 'a1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('claimForApply 404s a request from another workspace', async () => {
      const { prisma } = makePrisma(null);
      const svc = new ApprovalRequestService(prisma);
      await expect(svc.claimForApply('ws1', 'a-other')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('finishApply claims →APPLIED atomically, with appliedAt', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPLYING', expiresAt: null });
      const svc = new ApprovalRequestService(prisma);
      await svc.finishApply('ws1', 'a1');
      const call = updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: { in: ['APPLYING', 'APPROVED'] } });
      expect(call.data).toMatchObject({ status: 'APPLIED' });
      expect(call.data.appliedAt).toBeInstanceOf(Date);
    });

    // Issue #152: reapStaleApplying can pre-empt a live execution whose
    // heartbeat was silenced past STALE_APPLYING_MS and put the row back to
    // APPROVED while its tool call is still running. finishApply is only ever
    // called once the tool HAS run, so it must still land APPLIED — leaving
    // the row APPROVED shows a live Apply button that re-sends.
    it('finishApply still lands APPLIED when the reaper already returned the row to APPROVED', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPROVED', expiresAt: null });
      const svc = new ApprovalRequestService(prisma);
      await svc.finishApply('ws1', 'a1');
      expect(updateMany.mock.calls[0][0].where.status).toEqual({ in: ['APPLYING', 'APPROVED'] });
      expect(updateMany.mock.calls[0][0].data).toMatchObject({ status: 'APPLIED' });
    });

    it('finishApply is idempotent — a row already APPLIED is a success, not an error', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPLIED', expiresAt: null });
      updateMany.mockResolvedValue({ count: 0 });
      const svc = new ApprovalRequestService(prisma);
      await expect(svc.finishApply('ws1', 'a1')).resolves.toMatchObject({ status: 'APPLIED' });
    });

    it('finishApply retries a transient write failure instead of stranding the row', async () => {
      // The strand this repairs is the one it would otherwise create: a failed
      // terminal write leaves the row APPLYING, and the reaper hands it back
      // as re-appliable 60s later — for an action that already happened.
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPLYING', expiresAt: null });
      updateMany.mockRejectedValueOnce(new Error('connection terminated')).mockResolvedValue({ count: 1 });
      const svc = new ApprovalRequestService(prisma);
      await expect(svc.finishApply('ws1', 'a1')).resolves.toBeTruthy();
      expect(updateMany).toHaveBeenCalledTimes(2);
    });

    it('finishApply gives up after its bounded retries and rethrows the underlying fault', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPLYING', expiresAt: null });
      updateMany.mockRejectedValue(new Error('db down'));
      const svc = new ApprovalRequestService(prisma);
      await expect(svc.finishApply('ws1', 'a1')).rejects.toThrow(/db down/);
      expect(updateMany).toHaveBeenCalledTimes(3); // initial + 2 backoff attempts
    });

    it('finishApply rejects a state no executed action should be in, and does not retry it', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'REJECTED', expiresAt: null });
      updateMany.mockResolvedValue({ count: 0 });
      const svc = new ApprovalRequestService(prisma);
      await expect(svc.finishApply('ws1', 'a1')).rejects.toBeInstanceOf(BadRequestException);
      expect(updateMany).toHaveBeenCalledTimes(1); // a contract violation is not a transient fault
    });

    it('revertApply claims APPLYING→APPROVED atomically (releases the claim for retry)', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPLYING', expiresAt: null });
      const svc = new ApprovalRequestService(prisma);
      await svc.revertApply('ws1', 'a1');
      const call = updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'APPLYING' });
      expect(call.data).toEqual({ status: 'APPROVED' });
    });

    it('a real concurrent claimForApply race lets exactly one caller through (in-memory conditional updateMany)', async () => {
      // Models an actual Postgres `UPDATE ... WHERE status = 'APPROVED'`:
      // only the first of two simultaneous conditional writes can match.
      let status = 'APPROVED';
      const prisma = {
        approvalRequest: {
          findFirst: jest.fn(async () => ({ id: 'a1', workspaceId: 'ws1', status })),
          updateMany: jest.fn(async ({ where, data }: any) => {
            if (where.status && where.status !== status) return { count: 0 };
            status = data.status;
            return { count: 1 };
          }),
        },
      } as any;
      const svc = new ApprovalRequestService(prisma);
      const results = await Promise.allSettled([svc.claimForApply('ws1', 'a1'), svc.claimForApply('ws1', 'a1')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(status).toBe('APPLYING');
    });
  });

  // reapStaleApplying: crash recovery for the claim-first guard above — if
  // revertApply itself throws, or the process dies between claimForApply and
  // finishApply/revertApply, a row is stranded in APPLYING forever. Staleness
  // is judged purely by `updatedAt` (the heartbeat clock — see touchApplying
  // below), never by `createdAt`/how long the row has been APPLYING, because
  // a legitimately long-running publish (multi-account, IG carousel) keeps
  // refreshing `updatedAt` and must never be reclaimed out from under itself.
  // This simulates the real Postgres predicate (status + updatedAt
  // comparison) in-memory rather than asserting on call args, so "a fresh
  // row is left alone" is a genuine behavioural check, not a vacuous one.
  describe('reapStaleApplying', () => {
    function makeRows(rows: Array<{ id: string; status: string; updatedAt: Date; createdAt?: Date }>) {
      const state = new Map(rows.map((r) => [r.id, { createdAt: r.updatedAt, ...r }]));
      const updateMany = jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of state.values()) {
          if (where.status && row.status !== where.status) continue;
          if (where.updatedAt?.lt && !(row.updatedAt.getTime() < where.updatedAt.lt.getTime())) continue;
          Object.assign(row, data);
          count++;
        }
        return { count };
      });
      const prisma = { approvalRequest: { updateMany } } as any;
      return { prisma, state, updateMany };
    }

    const longAgo = new Date(Date.now() - 60 * 60 * 1000); // 1h ago — well past any plausible threshold
    const justNow = new Date(); // heartbeat freshly touched

    it('reclaims a row stuck in APPLYING past the threshold back to APPROVED', async () => {
      const { prisma, state } = makeRows([{ id: 'a1', status: 'APPLYING', updatedAt: longAgo }]);
      const svc = new ApprovalRequestService(prisma);

      await svc.reapStaleApplying();

      expect(state.get('a1')!.status).toBe('APPROVED');
    });

    it('leaves a freshly-claimed APPLYING row alone', async () => {
      const { prisma, state } = makeRows([{ id: 'a1', status: 'APPLYING', updatedAt: justNow }]);
      const svc = new ApprovalRequestService(prisma);

      await svc.reapStaleApplying();

      expect(state.get('a1')!.status).toBe('APPLYING');
    });

    // Fix round 1: a fixed APPLYING duration is not a valid staleness signal
    // — a multi-account/carousel publish can legitimately still be running
    // well past any plausible fixed threshold. touchApplying's heartbeat
    // keeps `updatedAt` fresh independent of `createdAt`/original claim
    // time, so a row claimed long ago but still heartbeating must survive.
    it('never reclaims a row whose heartbeat is fresh, even when it was claimed long ago', async () => {
      const { prisma, state } = makeRows([{ id: 'a1', status: 'APPLYING', createdAt: longAgo, updatedAt: justNow }]);
      const svc = new ApprovalRequestService(prisma);

      await svc.reapStaleApplying();

      expect(state.get('a1')!.status).toBe('APPLYING');
    });

    it('never touches APPLIED, REJECTED or PENDING rows, however old', async () => {
      const { prisma, state } = makeRows([
        { id: 'applied', status: 'APPLIED', updatedAt: longAgo },
        { id: 'rejected', status: 'REJECTED', updatedAt: longAgo },
        { id: 'pending', status: 'PENDING', updatedAt: longAgo },
      ]);
      const svc = new ApprovalRequestService(prisma);

      await svc.reapStaleApplying();

      expect(state.get('applied')!.status).toBe('APPLIED');
      expect(state.get('rejected')!.status).toBe('REJECTED');
      expect(state.get('pending')!.status).toBe('PENDING');
    });

    it('swallows errors (best-effort) instead of throwing, mirroring AgentRunService.reapStaleRuns', async () => {
      const prisma = { approvalRequest: { updateMany: jest.fn().mockRejectedValueOnce(new Error('db down')) } } as any;
      const svc = new ApprovalRequestService(prisma);

      await expect(svc.reapStaleApplying()).resolves.toBeUndefined();
    });
  });

  // touchApplying: the heartbeat write itself (McpApprovalExecutorService
  // calls this on a timer while broker.invoke() is in flight — see
  // mcp-approval-executor.service.spec.ts for the timer lifecycle).
  describe('touchApplying', () => {
    it('re-stamps updatedAt on a row that is still APPLYING (conditional, matches reapStaleApplying\'s predicate)', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPLYING', expiresAt: null });
      const svc = new ApprovalRequestService(prisma);

      await svc.touchApplying('ws1', 'a1');

      const call = updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'a1', workspaceId: 'ws1', status: 'APPLYING' });
      expect(call.data.updatedAt).toBeInstanceOf(Date);
    });

    it('is a harmless no-op once the row has already left APPLYING (finishApply/revertApply already ran)', async () => {
      const { prisma, updateMany } = makePrisma({ id: 'a1', workspaceId: 'ws1', status: 'APPLIED', expiresAt: null });
      updateMany.mockResolvedValue({ count: 0 }); // the APPLYING predicate no longer matches
      const svc = new ApprovalRequestService(prisma);

      await expect(svc.touchApplying('ws1', 'a1')).resolves.toBeUndefined();
    });
  });
});
