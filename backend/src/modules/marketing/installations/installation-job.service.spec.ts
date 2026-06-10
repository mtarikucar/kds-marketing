import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InstallationJobService } from './installation-job.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

describe('InstallationJobService', () => {
  let prisma: MockPrismaClient;
  let outbox: { append: jest.Mock };
  let svc: InstallationJobService;

  beforeEach(() => {
    prisma = mockPrismaClient();
    outbox = { append: jest.fn().mockResolvedValue('ob') };
    svc = new InstallationJobService(prisma as any, outbox as any);
    (prisma.$transaction as any).mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
  });

  describe('createForConversion', () => {
    it('is idempotent — returns the existing non-cancelled job', async () => {
      prisma.installationJob.findFirst.mockResolvedValue({ id: 'job-existing' } as any);
      const res = await svc.createForConversion(WS, { tenantId: 't1', leadId: 'l1' });
      expect(res).toEqual({ id: 'job-existing' });
      expect(prisma.installationJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: WS, tenantId: 't1' }),
        }),
      );
      expect(prisma.installationJob.create).not.toHaveBeenCalled();
    });

    it('creates a REQUESTED job born in the workspace, snapshotting the contact/site', async () => {
      prisma.installationJob.findFirst.mockResolvedValue(null);
      prisma.installationJob.create.mockResolvedValue({ id: 'job-new' } as any);
      await svc.createForConversion(WS, {
        tenantId: 't1',
        leadId: 'l1',
        contactName: 'Ada',
        siteCity: 'Istanbul',
      });
      expect(prisma.installationJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            workspaceId: WS,
            tenantId: 't1',
            leadId: 'l1',
            status: 'REQUESTED',
            contactName: 'Ada',
            siteCity: 'Istanbul',
          }),
        }),
      );
    });
  });

  describe('create', () => {
    it('creates a manual job carrying the workspaceId', async () => {
      prisma.installationJob.create.mockResolvedValue({ id: 'job-new' } as any);
      await svc.create(WS, { tenantId: 't1' } as any);
      expect(prisma.installationJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ workspaceId: WS, tenantId: 't1', status: 'REQUESTED' }),
        }),
      );
    });

    it('rejects a leadId from another workspace (scoped lookup misses)', async () => {
      prisma.lead.findFirst.mockResolvedValue(null);
      await expect(
        svc.create(WS, { tenantId: 't1', leadId: 'foreign-lead' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'foreign-lead', workspaceId: WS } }),
      );
      expect(prisma.installationJob.create).not.toHaveBeenCalled();
    });
  });

  describe('schedule', () => {
    beforeEach(() => {
      prisma.installationJob.findFirst.mockResolvedValue({
        id: 'job-1',
        workspaceId: WS,
        tenantId: 't1',
        status: 'REQUESTED',
      } as any);
      prisma.installationCrew.findFirst.mockResolvedValue({
        id: 'crew-1',
        workspaceId: WS,
        active: true,
        dailyCapacity: 1,
      } as any);
      prisma.installationJob.count.mockResolvedValue(0); // crew free
      prisma.installationJob.update.mockResolvedValue({ id: 'job-1', status: 'SCHEDULED' } as any);
    });

    it('assigns crew+date and emits installation.scheduled.v1', async () => {
      await svc.schedule(WS, 'job-1', { crewId: 'crew-1', scheduledDate: '2026-06-10' } as any);
      // Both the job and the crew are resolved through workspace-scoped reads.
      expect(prisma.installationJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'job-1', workspaceId: WS } }),
      );
      expect(prisma.installationCrew.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'crew-1', workspaceId: WS } }),
      );
      expect(prisma.installationJob.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ workspaceId: WS, crewId: 'crew-1' }),
        }),
      );
      expect(prisma.installationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            crewId: 'crew-1',
            status: 'SCHEDULED',
            scheduledAt: expect.any(Date),
          }),
        }),
      );
      expect(outbox.append.mock.calls[0][0]).toMatchObject({
        type: 'marketing.installation.scheduled.v1',
      });
    });

    it('rejects when the crew is fully booked on that date', async () => {
      prisma.installationJob.count.mockResolvedValue(1); // == capacity
      await expect(
        svc.schedule(WS, 'job-1', { crewId: 'crew-1', scheduledDate: '2026-06-10' } as any),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects scheduling a DONE job', async () => {
      prisma.installationJob.findFirst.mockResolvedValue({
        id: 'job-1',
        workspaceId: WS,
        tenantId: 't1',
        status: 'DONE',
      } as any);
      await expect(
        svc.schedule(WS, 'job-1', { crewId: 'crew-1', scheduledDate: '2026-06-10' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an inactive crew', async () => {
      prisma.installationCrew.findFirst.mockResolvedValue({
        id: 'crew-1',
        workspaceId: WS,
        active: false,
        dailyCapacity: 1,
      } as any);
      await expect(
        svc.schedule(WS, 'job-1', { crewId: 'crew-1', scheduledDate: '2026-06-10' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a crew from another workspace (scoped lookup misses)', async () => {
      prisma.installationCrew.findFirst.mockResolvedValue(null);
      await expect(
        svc.schedule(WS, 'job-1', { crewId: 'foreign-crew', scheduledDate: '2026-06-10' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('setStatus', () => {
    it('moves SCHEDULED → IN_PROGRESS and stamps startedAt', async () => {
      prisma.installationJob.findFirst.mockResolvedValue({
        id: 'job-1',
        workspaceId: WS,
        tenantId: 't1',
        status: 'SCHEDULED',
        crewId: 'crew-1',
      } as any);
      prisma.installationJob.update.mockResolvedValue({ id: 'job-1', status: 'IN_PROGRESS' } as any);
      await svc.setStatus(WS, 'job-1', 'IN_PROGRESS');
      expect(prisma.installationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'IN_PROGRESS', startedAt: expect.any(Date) }),
        }),
      );
    });

    it('emits installation.completed.v1 on DONE', async () => {
      prisma.installationJob.findFirst.mockResolvedValue({
        id: 'job-1',
        workspaceId: WS,
        tenantId: 't1',
        status: 'IN_PROGRESS',
        crewId: 'crew-1',
      } as any);
      prisma.installationJob.update.mockResolvedValue({ id: 'job-1', status: 'DONE' } as any);
      await svc.setStatus(WS, 'job-1', 'DONE');
      expect(outbox.append.mock.calls[0][0]).toMatchObject({
        type: 'marketing.installation.completed.v1',
      });
    });

    it('rejects an illegal transition (REQUESTED → DONE)', async () => {
      prisma.installationJob.findFirst.mockResolvedValue({
        id: 'job-1',
        workspaceId: WS,
        tenantId: 't1',
        status: 'REQUESTED',
      } as any);
      await expect(svc.setStatus(WS, 'job-1', 'DONE')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s a job from another workspace (scoped lookup misses)', async () => {
      prisma.installationJob.findFirst.mockResolvedValue(null);
      await expect(svc.setStatus(WS, 'job-1', 'DONE')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('tasks', () => {
    beforeEach(() => {
      // Parent job resolves in-workspace; task rows inherit its scope.
      prisma.installationJob.findFirst.mockResolvedValue({
        id: 'job-1',
        workspaceId: WS,
        status: 'REQUESTED',
      } as any);
    });

    it('appends a task at the next position', async () => {
      prisma.installationTask.count.mockResolvedValue(2);
      prisma.installationTask.create.mockResolvedValue({ id: 'task-1' } as any);
      await svc.addTask(WS, 'job-1', { title: 'Mount printer' } as any);
      expect(prisma.installationTask.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { jobId: 'job-1', job: { workspaceId: WS } } }),
      );
      expect(prisma.installationTask.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ jobId: 'job-1', title: 'Mount printer', position: 2 }),
        }),
      );
    });

    it('toggles a task done flag', async () => {
      prisma.installationTask.findUnique.mockResolvedValue({
        id: 'task-1',
        jobId: 'job-1',
        done: false,
      } as any);
      prisma.installationTask.update.mockResolvedValue({ id: 'task-1', done: true } as any);
      await svc.toggleTask(WS, 'job-1', 'task-1');
      expect(prisma.installationTask.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { done: true } }),
      );
    });

    it('rejects a task that belongs to another job', async () => {
      prisma.installationTask.findUnique.mockResolvedValue({
        id: 'task-1',
        jobId: 'other',
        done: false,
      } as any);
      await expect(svc.toggleTask(WS, 'job-1', 'task-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s before touching tasks when the parent job is outside the workspace', async () => {
      prisma.installationJob.findFirst.mockResolvedValue(null);
      await expect(svc.toggleTask(WS, 'job-1', 'task-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.installationTask.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('dashboard', () => {
    it('aggregates status counts, backlog, SLA breaches, and upcoming — workspace-scoped', async () => {
      // Cast to a plain mock — DeepMockProxy's typed groupBy signature
      // materialises Prisma 6's circular `having` type (TS2615) on access.
      (prisma.installationJob.groupBy as any).mockResolvedValue([
        { status: 'REQUESTED', _count: { _all: 3 } },
        { status: 'SCHEDULED', _count: { _all: 2 } },
      ]);
      (prisma.$transaction as any).mockResolvedValueOnce([3, 1, [{ id: 'job-up' }]]);
      const d = await svc.dashboard(WS);
      expect(prisma.installationJob.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { workspaceId: WS } }),
      );
      expect(d.byStatus).toEqual({ REQUESTED: 3, SCHEDULED: 2 });
      expect(d.unscheduled).toBe(3);
      expect(d.overdueSla).toBe(1);
      expect(d.upcoming).toEqual([{ id: 'job-up' }]);
    });
  });
});
