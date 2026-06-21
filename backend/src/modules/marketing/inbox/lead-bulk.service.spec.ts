import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeadBulkService } from './lead-bulk.service';

const WS = 'ws-1';

function makePrisma() {
  return {
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    workflow: { findFirst: jest.fn() },
  };
}

describe('LeadBulkService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let executor: { start: jest.Mock };
  let svc: LeadBulkService;

  beforeEach(() => {
    prisma = makePrisma();
    executor = { start: jest.fn() };
    svc = new LeadBulkService(prisma as any, executor as any);
  });

  describe('bulkDelete', () => {
    it('rejects an empty id set', async () => {
      await expect(svc.bulkDelete(WS, [])).rejects.toBeInstanceOf(BadRequestException);
    });

    it('soft-deletes scoped, only rows not already deleted', async () => {
      prisma.lead.updateMany.mockResolvedValue({ count: 2 });
      const res = await svc.bulkDelete(WS, ['a', 'b', 'a']);
      expect(res).toEqual({ deleted: 2 });
      const arg = prisma.lead.updateMany.mock.calls[0][0];
      expect(arg.where).toEqual({ id: { in: ['a', 'b'] }, workspaceId: WS, deletedAt: null });
      expect(arg.data.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('bulkEnroll', () => {
    it('404s an unknown workflow', async () => {
      prisma.workflow.findFirst.mockResolvedValue(null);
      await expect(svc.bulkEnroll(WS, ['a'], 'wf-x', 'me')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('starts the workflow once per scoped lead and counts only successful enrolls', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf-1', workspaceId: WS, version: 1, trigger: {}, steps: [] });
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
      // l1 enrolls (runId), l2 is a no-op duplicate (null)
      executor.start.mockResolvedValueOnce('run-1').mockResolvedValueOnce(null);
      const res = await svc.bulkEnroll(WS, ['l1', 'l2'], 'wf-1', 'me');
      expect(res).toEqual({ enrolled: 1, skipped: 1, failed: 0 });
      expect(executor.start).toHaveBeenCalledTimes(2);
      // enroll passes the lead subject + manual trigger payload
      expect(executor.start.mock.calls[0][1]).toEqual({ leadId: 'l1' });
      expect(executor.start.mock.calls[0][2]).toMatchObject({ manual: true, enrolledBy: 'me' });
      // leads are resolved workspace-scoped + non-deleted
      expect(prisma.lead.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: WS, deletedAt: null, mergedIntoId: null });
    });

    it('counts a real executor error as failed (not skipped)', async () => {
      prisma.workflow.findFirst.mockResolvedValue({ id: 'wf-1', workspaceId: WS, version: 1, trigger: {}, steps: [] });
      prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }]);
      executor.start.mockResolvedValueOnce('run-1').mockRejectedValueOnce(new Error('boom'));
      const res = await svc.bulkEnroll(WS, ['l1', 'l2'], 'wf-1', 'me');
      expect(res).toEqual({ enrolled: 1, skipped: 0, failed: 1 });
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
  });
});
