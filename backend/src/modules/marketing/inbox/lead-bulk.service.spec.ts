import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeadBulkService, LEAD_ENROLL_BATCH_KIND } from './lead-bulk.service';

const WS = 'ws-1';

function makePrisma() {
  return {
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    workflow: { findFirst: jest.fn() },
    scheduledJob: { findFirst: jest.fn().mockResolvedValue(null) },
  };
}

describe('LeadBulkService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let executor: { start: jest.Mock };
  let scheduledJobs: { schedule: jest.Mock };
  let runner: { registerHandler: jest.Mock };
  let svc: LeadBulkService;

  beforeEach(() => {
    prisma = makePrisma();
    executor = { start: jest.fn() };
    scheduledJobs = { schedule: jest.fn().mockResolvedValue('job-1') };
    runner = { registerHandler: jest.fn() };
    svc = new LeadBulkService(prisma as any, executor as any, scheduledJobs as any, runner as any);
  });

  it('registers the enroll-batch handler on init', () => {
    svc.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledWith(LEAD_ENROLL_BATCH_KIND, expect.any(Function));
  });

  describe('bulkDelete', () => {
    it('rejects an empty id set', async () => {
      await expect(svc.bulkDelete(WS, [])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('soft-deletes scoped, only rows not already deleted', async () => {
      prisma.lead.updateMany.mockResolvedValue({ count: 2 });
      prisma.lead.count.mockResolvedValue(0); // no protected leads in the batch
      const res = await svc.bulkDelete(WS, ['a', 'b', 'a']);
      expect(res).toEqual({ deleted: 2, skippedProtected: 0 });
      const arg = prisma.lead.updateMany.mock.calls[0][0];
      // Converted/WON leads are excluded from the tombstone (closed deals final).
      expect(arg.where).toEqual({
        id: { in: ['a', 'b'] },
        workspaceId: WS,
        deletedAt: null,
        convertedTenantId: null,
        status: { not: 'WON' },
      });
      expect(arg.data.deletedAt).toBeInstanceOf(Date);
    });

    // A converted/WON lead is FINAL — bulk-deleting one would hide it from won/lost
    // reporting while its provisioned tenant + earned commission dangle (the single
    // delete() refuses them). The bulk path must skip them and report the count.
    it('does not delete converted/WON leads and reports them as skippedProtected', async () => {
      prisma.lead.count.mockResolvedValue(1); // 1 of the batch is converted/WON
      prisma.lead.updateMany.mockResolvedValue({ count: 2 }); // the other 2 deleted
      const res = await svc.bulkDelete(WS, ['a', 'b', 'won']);
      expect(res).toEqual({ deleted: 2, skippedProtected: 1 });
      // The protected-count query targets the converted-OR-WON subset of the ids.
      const countWhere = prisma.lead.count.mock.calls[0][0].where;
      expect(countWhere).toMatchObject({
        workspaceId: WS,
        deletedAt: null,
        OR: [{ convertedTenantId: { not: null } }, { status: 'WON' }],
      });
    });
  });

  describe('bulkEnroll', () => {
    it('404s an unknown workflow', async () => {
      prisma.workflow.findFirst.mockResolvedValue(null);
      await expect(svc.bulkEnroll(WS, ['a'], 'wf-x', 'me')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('queues a background job for the scoped leads (does not enroll inline)', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf-1' });
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
      const res = await svc.bulkEnroll(WS, ['l1', 'l2'], 'wf-1', 'me');
      expect(res).toEqual({ queued: 2 });
      // no inline enroll — the executor is only touched by the batch handler
      expect(executor.start).not.toHaveBeenCalled();
      // leads are resolved workspace-scoped + non-deleted
      expect(prisma.lead.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, deletedAt: null, mergedIntoId: null });
      // an ids-mode job is enqueued with the resolved ids
      const job = scheduledJobs.schedule.mock.calls[0][0];
      expect(job).toMatchObject({ kind: LEAD_ENROLL_BATCH_KIND, workspaceId: WS, dedupKey: 'enroll:wf-1' });
      expect(job.payload).toMatchObject({ mode: 'ids', workflowId: 'wf-1', actorId: 'me', ids: ['l1', 'l2'], offset: 0 });
    });

    it('rejects when none of the ids resolve to scoped leads', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf-1' });
      prisma.lead.findMany.mockResolvedValue([]);
      await expect(svc.bulkEnroll(WS, ['x'], 'wf-1', 'me')).rejects.toBeInstanceOf(BadRequestException);
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('rejects when an enroll is already in flight for the workflow', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf-1' });
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }]);
      prisma.scheduledJob.findFirst.mockResolvedValue({ id: 'busy' });
      await expect(svc.bulkEnroll(WS, ['l1'], 'wf-1', 'me')).rejects.toBeInstanceOf(BadRequestException);
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });
  });

  describe('bulkEnrollByFilter', () => {
    it('404s an unknown workflow', async () => {
      prisma.workflow.findFirst.mockResolvedValue(null);
      await expect(svc.bulkEnrollByFilter(WS, {}, 'wf1', 'actor')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an empty filter without an explicit enrollAll confirmation', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1' });
      await expect(svc.bulkEnrollByFilter(WS, {}, 'wf1', 'actor', false)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.lead.count).not.toHaveBeenCalled();
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('rejects an empty match set', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1' });
      prisma.lead.count.mockResolvedValue(0);
      await expect(svc.bulkEnrollByFilter(WS, { status: 'NEW' }, 'wf1', 'actor')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a match set over the cap (does not enqueue)', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1' });
      prisma.lead.count.mockResolvedValue(9999);
      await expect(svc.bulkEnrollByFilter(WS, {}, 'wf1', 'actor', true)).rejects.toBeInstanceOf(BadRequestException);
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('queues a filter-mode job (whole-list enroll requires enrollAll)', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1' });
      prisma.lead.count.mockResolvedValue(3);
      const res = await svc.bulkEnrollByFilter(WS, {}, 'wf1', 'actor', true);
      expect(res).toEqual({ queued: 3 });
      expect(executor.start).not.toHaveBeenCalled();
      // count is workspace-scoped + excludes deleted/merged
      const where = prisma.lead.count.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: WS, deletedAt: null, mergedIntoId: null });
      const job = scheduledJobs.schedule.mock.calls[0][0];
      expect(job).toMatchObject({ kind: LEAD_ENROLL_BATCH_KIND, dedupKey: 'enroll:wf1' });
      expect(job.payload).toMatchObject({ mode: 'filter', workflowId: 'wf1', actorId: 'actor', afterId: null, processed: 0 });
    });

    it('queues with a single filter set (no enrollAll needed)', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1' });
      prisma.lead.count.mockResolvedValue(2);
      const res = await svc.bulkEnrollByFilter(WS, { status: 'NEW' }, 'wf1', 'actor');
      expect(res).toEqual({ queued: 2 });
      expect(prisma.lead.count.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, status: 'NEW' });
    });
  });

  describe('enrollBatch handler', () => {
    // Resolve the registered handler so we exercise the real fan-out logic.
    function handler() {
      svc.onModuleInit();
      return runner.registerHandler.mock.calls[0][1] as (job: any) => Promise<void>;
    }

    it('stops the chain when the workflow was deleted mid-fanout', async () => {
      prisma.workflow.findFirst.mockResolvedValue(null);
      const r = await handler()({ payload: { mode: 'ids', workspaceId: WS, workflowId: 'wf1', actorId: 'a', ids: ['l1'], offset: 0 } });
      expect(executor.start).not.toHaveBeenCalled();
      expect(r).toBeUndefined(); // void → runner marks DONE
    });

    it('ids mode: enrolls the scoped slice and ends the chain when drained', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1', workspaceId: WS });
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
      executor.start.mockResolvedValueOnce('run').mockResolvedValueOnce(null);
      const r = await handler()({ payload: { mode: 'ids', workspaceId: WS, workflowId: 'wf1', actorId: 'a', ids: ['l1', 'l2'], offset: 0 } });
      expect(executor.start).toHaveBeenCalledTimes(2);
      expect(executor.start.mock.calls[0][1]).toEqual({ leadId: 'l1' });
      expect(executor.start.mock.calls[0][2]).toMatchObject({ manual: true, enrolledBy: 'a' });
      expect(r).toBeUndefined(); // offset 2 >= ids.length 2 → no reschedule
    });

    it('ids mode: returns an in-place reschedule for the next offset when ids remain', async () => {
      const ids = Array.from({ length: 60 }, (_, i) => `l${i}`);
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1', workspaceId: WS });
      prisma.lead.findMany.mockResolvedValue(ids.slice(0, 50).map((id) => ({ id })));
      executor.start.mockResolvedValue('run');
      const r: any = await handler()({ payload: { mode: 'ids', workspaceId: WS, workflowId: 'wf1', actorId: 'a', ids, offset: 0 } });
      // The chain advances by RETURNING a directive — it never creates a child row.
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
      expect(r.reschedule.payload).toMatchObject({ mode: 'ids', offset: 50 });
      expect(r.reschedule.runAt).toBeInstanceOf(Date);
    });

    it('filter mode: walks by id cursor and returns a reschedule on a full batch', async () => {
      const page = Array.from({ length: 50 }, (_, i) => ({ id: `l${i}` }));
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1', workspaceId: WS });
      prisma.lead.findMany.mockResolvedValue(page);
      executor.start.mockResolvedValue('run');
      const r: any = await handler()({ payload: { mode: 'filter', workspaceId: WS, workflowId: 'wf1', actorId: 'a', filter: { status: 'NEW' }, afterId: null, processed: 0 } });
      // findMany is scoped + ordered by id asc + bounded
      const q = prisma.lead.findMany.mock.calls[0][0];
      expect(q.where).toMatchObject({ workspaceId: WS, status: 'NEW', deletedAt: null, mergedIntoId: null });
      expect(q.orderBy).toEqual({ id: 'asc' });
      expect(q.take).toBe(50);
      expect(scheduledJobs.schedule).not.toHaveBeenCalled();
      expect(r.reschedule.payload).toMatchObject({ mode: 'filter', afterId: 'l49', processed: 50 });
    });

    it('filter mode: a short batch drains the audience without rescheduling', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1', workspaceId: WS });
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }]);
      executor.start.mockResolvedValue('run');
      const r = await handler()({ payload: { mode: 'filter', workspaceId: WS, workflowId: 'wf1', actorId: 'a', filter: {}, afterId: null, processed: 0 } });
      expect(r).toBeUndefined();
    });

    it('filter mode: stops once the cap budget is exhausted', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf1', workspaceId: WS });
      const r = await handler()({ payload: { mode: 'filter', workspaceId: WS, workflowId: 'wf1', actorId: 'a', filter: {}, afterId: 'x', processed: 5000 } });
      expect(prisma.lead.findMany).not.toHaveBeenCalled();
      expect(r).toBeUndefined();
    });
  });

  describe('exportCsv', () => {
    it('emits an RFC-4180 header + rows with quoting/escaping, workspace-scoped', async () => {
      prisma.lead.findMany.mockResolvedValueOnce([
        {
          id: 'l1',
          businessName: 'Acme, Inc.', // comma → must be quoted
          contactPerson: 'Jane "JD" Doe', // inner quotes → doubled
          phone: '+90555',
          email: 'jane@x.test',
          status: 'NEW',
          city: 'Ankara',
          region: 'IC',
          source: 'WEBSITE',
          businessType: 'CAFE',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        },
      ]);
      const csv = await svc.exportCsv(WS, {});
      const lines = csv.split('\r\n');
      expect(lines[0]).toBe('Business Name,Contact Person,Phone,Email,Status,City,Region,Source,Business Type,Created At');
      expect(lines[1]).toContain('"Acme, Inc."');
      expect(lines[1]).toContain('"Jane ""JD"" Doe"');
      expect(prisma.lead.findMany.mock.calls[0][0].where.workspaceId).toBe(WS);
      expect(prisma.lead.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
    });

    it('neutralizes a formula-injection cell (leading = / + / - / @)', async () => {
      prisma.lead.findMany.mockResolvedValueOnce([
        { id: 'l1', businessName: '=HYPERLINK("http://evil","x")', contactPerson: '+attack', phone: '@cmd', email: '', status: 'NEW', city: '', region: '', source: '', businessType: '', createdAt: new Date('2026-06-01T00:00:00Z') },
      ]);
      const csv = await svc.exportCsv(WS, {});
      const row = csv.split('\r\n')[1];
      // a leading apostrophe is prepended; the comma then forces quoting
      expect(row).toContain('"\'=HYPERLINK');
      expect(row).toContain("'+attack");
      expect(row).toContain("'@cmd");
    });

    // The CSV must reflect the SAME filters the list shows — previously the
    // controller forwarded only status/assignedToId/search, so source,
    // businessType and the assignment filter silently fell out of the export.
    const whereOf = () => prisma.lead.findMany.mock.calls[0][0].where;

    it('applies source + businessType filters to the export query', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      await svc.exportCsv(WS, { source: 'WEBSITE', businessType: 'CAFE' }, 'mgr-1', 'MANAGER');
      expect(whereOf()).toMatchObject({ workspaceId: WS, source: 'WEBSITE', businessType: 'CAFE' });
    });

    it('maps assignmentStatus=unassigned to assignedToId null', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      await svc.exportCsv(WS, { assignmentStatus: 'unassigned' }, 'mgr-1', 'MANAGER');
      expect(whereOf().assignedToId).toBeNull();
    });

    it('maps assignmentStatus=assigned to assignedToId not-null', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      await svc.exportCsv(WS, { assignmentStatus: 'assigned' }, 'mgr-1', 'MANAGER');
      expect(whereOf().assignedToId).toEqual({ not: null });
    });

    it('maps assignmentStatus=mine to the actor', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      await svc.exportCsv(WS, { assignmentStatus: 'mine' }, 'mgr-1', 'MANAGER');
      expect(whereOf().assignedToId).toBe('mgr-1');
    });

    it('scopes a REP to their own leads regardless of assignmentStatus', async () => {
      prisma.lead.findMany.mockResolvedValue([]);
      await svc.exportCsv(WS, { assignmentStatus: 'assigned' }, 'rep-1', 'REP');
      expect(whereOf().assignedToId).toBe('rep-1');
    });
  });
});
