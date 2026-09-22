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
    let lastError: string | null = null;
    const prisma: any = {
      workflowRun: {
        create: jest.fn().mockResolvedValue({ id: 'run-1' }),
        // No prior run, unless a test says otherwise (the re-entry guard).
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockImplementation(async () => ({
          id: 'run-1', workspaceId: WS, workflowId: 'wf-1', leadId: 'lead-1',
          status, cursor, context, depth: 0,
        })),
        update: jest.fn().mockImplementation(async ({ data }: any) => {
          if (data.status) status = data.status;
          if (data.cursor) cursor = data.cursor;
          if (data.context) context = data.context;
          if (data.lastError !== undefined) lastError = data.lastError;
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
    return {
      executor, prisma, handler, scheduledJobs,
      status: () => status,
      lastError: () => lastError,
      context: () => context,
    };
  }

  /** The shape WorkflowTriggerService hands `start()`. */
  const workflow = (trigger: any = { type: 'lead.created', filters: [] }) =>
    ({ id: 'wf-1', workspaceId: WS, version: 1, trigger, steps: [] }) as any;

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


  /**
   * A leaf action that cannot do its job reports it in its output string
   * instead of throwing. Recording that as DONE made a no-op indistinguishable
   * from success — seen live: an armed "create a follow-up task" automation
   * ran, the run said DONE, every step showed green, and no task existed
   * (the workspace had no rep to own it).
   */
  it('records a step that reported "skipped" as SKIPPED, not DONE', async () => {
    const h = build([{ type: 'create_task', title: 't' }], [{ output: { result: 'skipped (no assignee for task)' } }]);

    await h.executor.start(
      { id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any,
      { leadId: 'lead-1' },
      {},
    );

    const step = h.prisma.workflowStepRun.create.mock.calls[0][0].data;
    expect(step.status).toBe('SKIPPED');
    expect(step.output.result).toContain('skipped');
  });

  it('still records DONE for an action that actually did something', async () => {
    const h = build([{ type: 'create_task', title: 't' }], [{ output: { result: 'task created' } }]);

    await h.executor.start(
      { id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any,
      { leadId: 'lead-1' },
      {},
    );

    expect(h.prisma.workflowStepRun.create.mock.calls[0][0].data.status).toBe('DONE');
  });

  // The seam that makes a mail idempotent: the leaf cannot key a send on
  // (run, step, lead) unless the executor says which run and step this is.
  it('tells each step which run and step it is', async () => {
    const h = build([{ type: 'send_email', subject: 's', body: 'b' }], [{}]);

    await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

    expect(h.handler.execute.mock.calls[0][1].run).toEqual({
      id: 'run-1', workflowId: 'wf-1', stepIndex: 0,
    });
  });

  /**
   * A mail the relay refused is not a completed step. It used to be recorded
   * DONE — the status came from a `startsWith('skipped')` prefix match, and
   * "email NOT sent (…)" is not that prefix — so SMTP could be broken for a
   * week and the list still read "120 → 120 completed"
   * (`failed-automation-done`). The leaf now says so structurally, and the
   * status is derived from the flag, never from English prose.
   */
  /**
   * The send window defers; it does not drop. A drip that fires at 02:30 must
   * still reach the customer at 09:00 — a mail nobody read is a missed mail,
   * but a mail nobody SENT is a broken automation.
   */
  describe('a step the send window deferred', () => {
    const at = new Date(Date.now() + 6 * 3600_000);
    const deferred = [
      { output: { result: 'deferred (outside the send window)' }, retryStep: { at } },
      { output: { result: 'task created' } },
    ];

    it('parks the run and schedules the resume for the window opening', async () => {
      const h = build(
        [{ type: 'send_email', subject: 's', body: 'b' }, { type: 'create_task', title: 't' }],
        deferred,
      );

      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

      expect(h.status()).toBe('WAITING');
      expect(h.scheduledJobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'workflow.resume', runAt: at, dedupKey: 'run-1' }),
      );
    });

    it('resumes at the SAME step, because nothing was sent', async () => {
      const h = build(
        [{ type: 'send_email', subject: 's', body: 'b' }, { type: 'create_task', title: 't' }],
        deferred,
      );

      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

      expect(h.context().__resumeIndex).toBe(0);
      // The step after it must NOT have run: the drip's own order is the point.
      expect(h.handler.execute).toHaveBeenCalledTimes(1);
    });

    it('records the step WAITING rather than green', async () => {
      const h = build(
        [{ type: 'send_email', subject: 's', body: 'b' }, { type: 'create_task', title: 't' }],
        deferred,
      );

      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

      expect(h.prisma.workflowStepRun.create.mock.calls[0][0].data.status).toBe('WAITING');
    });

    it('sends anyway once a step has been deferred too often', async () => {
      // A window that keeps moving under the run would otherwise loop forever
      // without ever sending.
      const h = build(
        [{ type: 'send_email', subject: 's', body: 'b' }],
        deferred,
        undefined,
        { __deferrals_0: 3 },
      );

      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

      expect(h.status()).toBe('DONE');
      expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    });
  });

  describe('a step that failed', () => {
    const failing = (error = 'relay refused: 550 mailbox unavailable') =>
      [{ output: { result: 'email NOT sent (relay refused)', ok: false, error } }, { output: { result: 'task created' } }];

    it('is recorded FAILED with the error, not DONE', async () => {
      const h = build(
        [{ type: 'send_email', subject: 's', body: 'b' }, { type: 'create_task', title: 't' }],
        failing(),
      );

      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

      const step = h.prisma.workflowStepRun.create.mock.calls[0][0].data;
      expect(step.status).toBe('FAILED');
      expect(step.error).toContain('550 mailbox unavailable');
    });

    // The regression this must not become: aborting the run would skip the
    // tag-add, the create_task and the update_lead that follow a mail in a
    // normal drip, so one throttled recipient would silently kill the rest of
    // that lead's automation.
    it('does NOT fail the run — every later step still runs', async () => {
      const h = build(
        [{ type: 'send_email', subject: 's', body: 'b' }, { type: 'create_task', title: 't' }],
        failing(),
      );

      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

      expect(h.status()).toBe('DONE');
      expect(h.handler.execute).toHaveBeenCalledTimes(2);
      expect(h.prisma.workflowStepRun.create.mock.calls[1][0].data.status).toBe('DONE');
    });

    // GET /workflows/:id/runs already selects lastError. Without the
    // breadcrumb it stays blank for exactly the runs an owner needs to find.
    it('leaves the first error on the run so the runs list can show it', async () => {
      const h = build(
        [{ type: 'send_email', subject: 's', body: 'b' }, { type: 'create_task', title: 't' }],
        failing(),
      );

      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

      expect(h.lastError()).toContain('550 mailbox unavailable');
      expect(h.context().__hadFailures).toBe(true);
    });

    it('a run that failed nothing still finishes with a clean lastError', async () => {
      const h = build([{ type: 'create_task', title: 't' }], [{ output: { result: 'task created' } }]);
      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});
      expect(h.lastError()).toBeNull();
    });

    it('a skipped step is still SKIPPED, not FAILED (they are different states)', async () => {
      const h = build(
        [{ type: 'send_email', subject: 's', body: 'b' }],
        [{ output: { result: 'skipped (lead opted out of email)' } }],
      );

      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});

      expect(h.prisma.workflowStepRun.create.mock.calls[0][0].data.status).toBe('SKIPPED');
      expect(h.status()).toBe('DONE');
      expect(h.lastError()).toBeNull();
    });
  });

  /**
   * `link.clicked` is the one trigger a single lead fires over and over. The
   * only enrolment guard is the active-run partial unique index, and a
   * one-step send workflow finishes inside start() in milliseconds — so a
   * scanner prefetch plus the human's own click sent the same code twice, and
   * a link INSIDE the mail re-enrolled the lead every time it was followed
   * (`link-clicked-reenroll`).
   */
  describe('link.clicked re-entry', () => {
    const clickTrigger = (reentry?: any) => ({ type: 'link.clicked', filters: [], ...(reentry ? { reentry } : {}) });

    it('does not re-enrol the same lead within the cooldown', async () => {
      const h = build([{ type: 'send_email', subject: 's', body: 'b' }], [{}]);
      h.prisma.workflowRun.findFirst.mockResolvedValue({ id: 'run-earlier' });

      const runId = await h.executor.start(workflow(clickTrigger()), { leadId: 'lead-1' }, {});

      expect(runId).toBeNull();
      expect(h.prisma.workflowRun.create).not.toHaveBeenCalled();
      const where = h.prisma.workflowRun.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: WS, workflowId: 'wf-1', leadId: 'lead-1' });
      expect(where.createdAt.gte).toBeInstanceOf(Date);
    });

    it('enrols normally once the cooldown has passed (no prior run in the window)', async () => {
      const h = build([{ type: 'send_email', subject: 's', body: 'b' }], [{}]);
      const runId = await h.executor.start(workflow(clickTrigger()), { leadId: 'lead-1' }, {});
      expect(runId).toBe('run-1');
    });

    // "Click here to request a callback" is a legitimate repeat-use pattern, so
    // once-per-lead is the author's choice and never the default.
    it('honours once_per_lead by asking about ANY prior run, not a window', async () => {
      const h = build([{ type: 'send_email', subject: 's', body: 'b' }], [{}]);
      h.prisma.workflowRun.findFirst.mockResolvedValue({ id: 'run-last-year' });

      const runId = await h.executor.start(
        workflow(clickTrigger({ mode: 'once_per_lead' })), { leadId: 'lead-1' }, {},
      );

      expect(runId).toBeNull();
      expect(h.prisma.workflowRun.findFirst.mock.calls[0][0].where.createdAt).toBeUndefined();
    });

    it('an author who asked for "always" gets today’s behaviour back', async () => {
      const h = build([{ type: 'send_email', subject: 's', body: 'b' }], [{}]);
      const runId = await h.executor.start(
        workflow(clickTrigger({ mode: 'always' })), { leadId: 'lead-1' }, {},
      );
      expect(runId).toBe('run-1');
      expect(h.prisma.workflowRun.findFirst).not.toHaveBeenCalled();
    });

    // Every other trigger fires once per real-world event, and a blanket
    // cooldown would break the ones that legitimately repeat (a status change
    // back and forth, a second booking).
    it('leaves every other trigger type alone', async () => {
      const h = build([{ type: 'create_task', title: 't' }], [{}]);
      await h.executor.start(workflow(), { leadId: 'lead-1' }, {});
      expect(h.prisma.workflowRun.findFirst).not.toHaveBeenCalled();
    });

    // A click with no resolvable ?c= has no lead to key on. The source-event id
    // still dedupes a redelivery, so this stays exactly as it was.
    it('leaves a leadless click alone (nothing to key a cooldown on)', async () => {
      const h = build([{ type: 'create_task', title: 't' }], [{}]);
      await h.executor.start(workflow(clickTrigger()), { leadId: null }, {}, 0, 'evt-1');
      expect(h.prisma.workflowRun.findFirst).not.toHaveBeenCalled();
    });

    // A child start is not an enrolment: the parent already decided.
    it('does not apply to a child workflow start', async () => {
      const h = build([{ type: 'create_task', title: 't' }], [{}]);
      await h.executor.start(workflow(clickTrigger()), { leadId: 'lead-1' }, {}, 1);
      expect(h.prisma.workflowRun.findFirst).not.toHaveBeenCalled();
    });
  });
});
