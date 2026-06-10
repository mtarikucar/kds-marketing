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

  function build(steps: any[], outcomes: any[]) {
    let status = 'RUNNING';
    let cursor: any = { stepIndex: 0 };
    let context: any = { _trigger: {} };
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
          return {};
        }),
      },
      workflow: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps,
        }),
      },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-1', workspaceId: WS }) },
      workflowStepRun: { create: jest.fn().mockResolvedValue({}) },
    };
    const handler: any = { execute: jest.fn() };
    outcomes.forEach((o) => handler.execute.mockResolvedValueOnce(o));
    handler.execute.mockResolvedValue({});
    const scheduledJobs: any = { schedule: jest.fn().mockResolvedValue('job') };
    const runner: any = { registerHandler: jest.fn() };
    const executor = new WorkflowExecutorService(prisma, handler, scheduledJobs, runner);
    return { executor, prisma, handler, scheduledJobs, status: () => status };
  }

  it('runs a linear automation to DONE', async () => {
    const h = build(
      [{ type: 'create_task', title: 't' }, { type: 'notify_user', message: 'm' }],
      [{}, {}],
    );
    await h.executor.start({ id: 'wf-1', workspaceId: WS, version: 1, trigger: { type: 'lead.created', filters: [] }, steps: [] } as any, { leadId: 'lead-1' }, {});
    expect(h.status()).toBe('DONE');
    expect(h.handler.execute).toHaveBeenCalledTimes(2);
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
});
