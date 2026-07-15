import { Prisma } from '@prisma/client';
import { WorkflowExecutorService } from './workflow-executor.service';

/**
 * The executor's control flow: a linear run reaches DONE, `wait` parks the run
 * as WAITING + schedules a resume job, `branch` jumps the cursor, `stop` ends
 * it, and a duplicate start (partial-unique race) is a no-op. The handler is
 * mocked — this is the cursor/orchestration contract, not the leaf actions.
 */
describe('WorkflowExecutorService', () => {
  const WS = 'ws-1';

  function build(steps: any[], outcomes: any[], goal?: any, seedContext?: any) {
    let status = 'RUNNING';
    let cursor: any = { stepIndex: 0 };
    let context: any = { _trigger: {}, ...(seedContext ?? {}) };
    const prisma: any = {
      workflowRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        findUnique: jest.fn().mockImplementation(async () => ({
          id: 'run-1', workspaceId: WS, workflowId: 'wf-1', leadId: 'lead-1',
          status, cursor, context, depth: 0,
        })),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          if (data.status) status = data.status;
          if (data.cursor) cursor = data.cursor;
          if (data.context) context = data.context;
          return { workspaceId: WS, workflowId: 'wf-1' };
        }),
      },
      workflow: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps, goal: goal ?? null,
        }),
      },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1', workspaceId: WS }) },
      workflowStepRun: { create: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    const handler: any = { execute: jest.fn(), matchesAll: jest.fn().mockReturnValue(false) };
    outcomes.forEach((o) => handler.execute.mockResolvedValueOnce(o));
    handler.execute.mockResolvedValue({});
    const scheduledJobs: any = { schedule: jest.fn().mockResolvedValue('job') };
    const runner: any = { registerHandler: jest.fn() };
    const executor = new WorkflowExecutorService(prisma, handler, scheduledJobs, runner);
    return { executor, prisma, handler, scheduledJobs, status: () => status };
  }

  /** Pull the interpolated values of a $executeRaw tagged-template call. */
  const rawValues = (prisma: any, callIndex: number) => prisma.$executeRaw.mock.calls[callIndex]?.slice(1) ?? [];

  it('runs a linear automation to DONE', async () => {
    const h = build(
      [{ type: 'create_task', title: 't' }, { type: 'notify_user', message: 'm' }],
      [{}, {}],
    );
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('DONE');
    expect(h.handler.execute).toHaveBeenCalledTimes(2);
  });

  // A workflow runs over days (waits between steps). If the lead is bulk-deleted
  // or merged DURING a wait, the run must not keep acting on it (send_email/SMS,
  // create_task) across the resume — bulk-delete means "stop contacting". The
  // lead load applies the active predicate, so a vanished lead resolves to null
  // and the lead-scoped run is STOPPED (parallel to the workflow-deleted guard).
  it('stops a lead-scoped run whose lead was deleted/merged mid-flight (runs no steps)', async () => {
    const h = build(
      [{ type: 'send_email', subject: 's', body: 'b' }],
      [{}],
    );
    h.prisma.lead.findFirst.mockResolvedValue(null); // lead deleted/merged → resolves null
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('STOPPED');
    expect(h.handler.execute).not.toHaveBeenCalled();
  });

  it('parks on wait and schedules a workflow.resume job', async () => {
    const h = build(
      [{ type: 'wait', mode: 'duration', seconds: 3600 }],
      [{ wait: { seconds: 3600 } }],
    );
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('WAITING');
    expect(h.scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workflow.resume', dedupKey: 'run-1' }),
    );
  });

  it('branch jumps the cursor (skips the in-between step)', async () => {
    const h = build(
      [
        { type: 'branch', filters: [] },
        { type: 'stop_workflow' },
        { type: 'notify_user', message: 'm' },
      ],
      [{ goto: 2 }], // branch → jump to step 2, skipping the stop at index 1
    );
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('DONE');
    expect(h.handler.execute).toHaveBeenCalledTimes(2); // branch + notify (stop skipped)
  });

  it('stop_workflow ends the run as STOPPED', async () => {
    const h = build([{ type: 'stop_workflow' }], [{ stop: true }]);
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('STOPPED');
  });

  it('a duplicate start (partial-unique race) is a no-op', async () => {
    const h = build([{ type: 'stop_workflow' }], []);
    h.prisma.workflowRun.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6' }),
    );
    const runId = await h.executor.start(
      { id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any,
      { leadId: 'lead-1' }, {},
    );
    expect(runId).toBeNull();
  });

  it('persists triggerEventId so a redelivered event is deduped (durable idempotency)', async () => {
    const h = build([{ type: 'stop_workflow' }], []);
    await h.executor.start(
      { id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'webhook.received', filters: [] }, steps: [] } as any,
      { leadId: null }, {}, 0, 'evt-hook-1',
    );
    expect(h.prisma.workflowRun.create.mock.calls[0][0].data).toMatchObject({ triggerEventId: 'evt-hook-1' });
  });

  it('a child workflow start carries NO triggerEventId (not event-triggered)', async () => {
    const h = build([{ type: 'stop_workflow' }], []);
    await h.executor.start(
      { id: 'wf-child', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any,
      { leadId: 'lead-1' }, {}, 1, // depth 1, no triggerEventId
    );
    expect(h.prisma.workflowRun.create.mock.calls[0][0].data.triggerEventId).toBeNull();
  });

  it('bumps stats: started on create, completed on DONE', async () => {
    const h = build([{ type: 'notify_user', message: 'm' }], [{}]);
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    // started (in start) then completed (in finish) — two atomic bumps.
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(rawValues(h.prisma, 0)).toContain('started');
    expect(rawValues(h.prisma, 1)).toContain('completed');
  });

  it('counts a FAILED run under the failed stat', async () => {
    const h = build([{ type: 'notify_user', message: 'm' }], []);
    h.handler.execute.mockReset();
    h.handler.execute.mockRejectedValue(new Error('boom'));
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('FAILED');
    expect(rawValues(h.prisma, 0)).toContain('started');
    expect(rawValues(h.prisma, 1)).toContain('failed');
  });

  it('a met "exit" goal short-circuits the run to DONE before any step runs', async () => {
    const h = build(
      [{ type: 'notify_user', message: 'm' }],
      [{}],
      { filters: [{ field: 'lead.status', op: 'eq', value: 'customer' }], onMet: 'exit' },
    );
    h.handler.matchesAll.mockReturnValue(true); // goal met immediately
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('DONE');
    expect(h.handler.execute).not.toHaveBeenCalled(); // exited before the step
  });

  it('a met "goto" goal jumps the cursor to the target step', async () => {
    const h = build(
      [
        { type: 'notify_user', message: 'first' },
        { type: 'notify_user', message: 'second' },
      ],
      [{}],
      { filters: [{ field: 'lead.status', op: 'eq', value: 'hot' }], onMet: 'goto', gotoStep: 1 },
    );
    // Goal matches once (jump 0→1), then must NOT re-fire at the target (skip
    // when already AT gotoStep) so step 1 executes and the run completes.
    h.handler.matchesAll.mockReturnValueOnce(true).mockReturnValue(false);
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('DONE');
    expect(h.handler.execute).toHaveBeenCalledTimes(1); // only the target step (index 1)
    expect(h.handler.execute.mock.calls[0][0]).toMatchObject({ message: 'second' });
  });

  it('caps lifetime goal goto-jumps per run (cross-resume cycle backstop)', async () => {
    // Seed the run near the cap, as if 100 jumps already happened across prior
    // resumes. A goto goal that loops back over a `wait` would otherwise re-fire
    // forever; the persisted __goalJumps counter (not the per-advance step
    // ceiling) is what bounds it. The next jump must FAIL the run.
    const h = build(
      [{ type: 'notify_user', message: 'a' }, { type: 'notify_user', message: 'b' }],
      [{}],
      { filters: [{ field: 'lead.status', op: 'eq', value: 'loop' }], onMet: 'goto', gotoStep: 0 },
      { __goalJumps: 100 },
    );
    h.handler.matchesAll.mockReturnValue(true); // goal always met → would loop
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('FAILED');
  });
});
