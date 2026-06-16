import { ImportService } from './import.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const customFields = { validateAndNormalize: jest.fn().mockResolvedValue({}) };
  const tags = { assignToLead: jest.fn().mockResolvedValue([]) };
  const scheduledJob = { schedule: jest.fn().mockResolvedValue('job-1') };
  const runner = { registerHandler: jest.fn() };
  const svc = new ImportService(
    prisma as any,
    customFields as any,
    tags as any,
    scheduledJob as any,
    runner as any,
  );
  return { prisma, customFields, tags, scheduledJob, runner, svc };
}

describe('ImportService.suggestMapping', () => {
  it('maps header synonyms to native fields and skips unknowns', () => {
    const { svc } = makeSvc();
    expect(svc.suggestMapping(['Company', 'E-Mail', 'Tags', 'Mystery'])).toEqual({
      Company: 'businessName',
      'E-Mail': 'email',
      Tags: 'tags',
      Mystery: '__skip',
    });
  });
});

describe('ImportService.upload', () => {
  it('parses, stores rows, and returns a suggested mapping', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.importJob.create as jest.Mock).mockResolvedValue({ id: 'imp-1' });
    (prisma.importJobRow.createMany as jest.Mock).mockResolvedValue({ count: 1 });

    const out = await svc.upload(WS, 'leads.csv', 'business,email\nAcme,a@x.com', 'u1');
    expect(out).toMatchObject({
      jobId: 'imp-1',
      headers: ['business', 'email'],
      suggestedMapping: { business: 'businessName', email: 'email' },
      total: 1,
    });
    expect(prisma.importJobRow.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ importJobId: 'imp-1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } }],
      }),
    );
  });
});

describe('ImportService.commit', () => {
  it('sets RUNNING and enqueues an import.batch job', async () => {
    const { prisma, scheduledJob, svc } = makeSvc();
    prisma.importJob.findFirst.mockResolvedValue({ id: 'imp-1', workspaceId: WS, status: 'MAPPING' } as any);
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    await svc.commit(WS, 'imp-1', { business: 'businessName' }, 'CREATE');
    expect((prisma.importJob.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ status: 'RUNNING', dedupePolicy: 'CREATE' });
    expect(scheduledJob.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'import.batch', payload: { jobId: 'imp-1', offset: 0 } }),
    );
  });
});

describe('ImportService.processBatch', () => {
  const baseJob = {
    id: 'imp-1',
    workspaceId: WS,
    status: 'RUNNING',
    mapping: { business: 'businessName', email: 'email' },
    errors: null,
  };

  it('creates leads under the CREATE policy and finishes when no rows remain', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, dedupePolicy: 'CREATE' } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue(null as any);
    (prisma.lead.create as jest.Mock).mockResolvedValue({ id: 'lead-1' });
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: WS, businessName: 'Acme', source: 'IMPORT' }),
      }),
    );
    // counters incremented then job marked DONE
    const updates = (prisma.importJob.update as jest.Mock).mock.calls.map((c) => c[0].data);
    expect(updates.some((d) => d.created?.increment === 1)).toBe(true);
    expect(updates.some((d) => d.status === 'DONE')).toBe(true);
  });

  it('skips an existing lead under the SKIP policy (no create)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, dedupePolicy: 'SKIP' } as any);
    prisma.importJobRow.findMany.mockResolvedValue([
      { id: 'r1', rowIndex: 0, raw: { business: 'Acme', email: 'a@x.com' } },
    ] as any);
    prisma.lead.findFirst.mockResolvedValue({ id: 'existing-1', customFields: {} } as any);
    (prisma.importJobRow.update as jest.Mock).mockResolvedValue({});
    (prisma.importJob.update as jest.Mock).mockResolvedValue({});
    (prisma.importJobRow.count as jest.Mock).mockResolvedValue(0);

    await svc.processBatch('imp-1', 0);

    expect(prisma.lead.create).not.toHaveBeenCalled();
    expect(prisma.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'r1' }, data: expect.objectContaining({ status: 'SKIPPED' }) }),
    );
  });

  it('does nothing when the job is not RUNNING', async () => {
    const { prisma, svc } = makeSvc();
    prisma.importJob.findUnique.mockResolvedValue({ ...baseJob, status: 'DONE' } as any);
    await svc.processBatch('imp-1', 0);
    expect(prisma.importJobRow.findMany).not.toHaveBeenCalled();
  });
});
