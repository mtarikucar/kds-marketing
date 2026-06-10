import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import {
  CreateJobDto,
  ScheduleJobDto,
  CreateInstallTaskDto,
  JobFilterDto,
} from './dto/installation-job.dto';
import { toUtcDateOnly } from './installation.util';
import { paginated } from '../../../common/pagination';

/** Crew slot is occupied by jobs in these statuses on a day. */
const OCCUPYING_STATUSES = ['SCHEDULED', 'IN_PROGRESS'];

/** Allowed status transitions for the direct status endpoint (scheduling is separate). */
const SET_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ['CANCELLED'],
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['DONE', 'CANCELLED'],
  DONE: [],
  CANCELLED: [],
  NO_SHOW: ['CANCELLED'],
};

/** schedule()/reschedule() is permitted from these statuses. */
const SCHEDULABLE_FROM = ['REQUESTED', 'SCHEDULED', 'NO_SHOW'];

const SLA_DAYS = 3;

@Injectable()
export class InstallationJobService {
  private readonly logger = new Logger(InstallationJobService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Auto-create an installation job when a lead converts (idempotent: one
   * non-cancelled job per tenant from auto-creation). Site/contact are
   * snapshotted by the caller from the marketing-owned Lead, and the
   * workspaceId comes from that same lead row (the consumer's scope anchor).
   *
   * Idempotency is a check-then-act guarded by the single-threaded outbox
   * worker (one consumer execution per event) plus the convertedTenantId
   * lead-claim upstream, so concurrent duplicates are not produced in
   * practice. A partial unique index on (tenantId) WHERE status<>'CANCELLED'
   * is the belt-and-suspenders follow-up but is deferred: existing data may
   * already hold multiple non-cancelled jobs per tenant, so adding it needs a
   * dedup migration first.
   */
  async createForConversion(
    workspaceId: string,
    input: {
      tenantId: string;
      leadId?: string | null;
      contactName?: string | null;
      contactPhone?: string | null;
      siteAddress?: string | null;
      siteCity?: string | null;
    },
  ) {
    const existing = await this.prisma.installationJob.findFirst({
      where: { workspaceId, tenantId: input.tenantId, status: { not: 'CANCELLED' } },
      select: { id: true },
    });
    if (existing) return existing;

    try {
      return await this.prisma.installationJob.create({
        data: {
          workspaceId,
          tenantId: input.tenantId,
          leadId: input.leadId ?? null,
          contactName: input.contactName ?? null,
          contactPhone: input.contactPhone ?? null,
          siteAddress: input.siteAddress ?? null,
          siteCity: input.siteCity ?? null,
          status: 'REQUESTED',
        },
      });
    } catch (e) {
      // Backs the partial unique index (tenantId WHERE status<>'CANCELLED'):
      // if a concurrent consumer won the race, return its job instead of
      // surfacing a 500 / minting a duplicate.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const won = await this.prisma.installationJob.findFirst({
          where: { workspaceId, tenantId: input.tenantId, status: { not: 'CANCELLED' } },
        });
        if (won) return won;
      }
      throw e;
    }
  }

  async create(workspaceId: string, dto: CreateJobDto) {
    // leadId is a soft cross-reference — make sure it can't point into
    // another workspace's lead before the job is born carrying it.
    if (dto.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: dto.leadId, workspaceId },
        select: { id: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    }
    return this.prisma.installationJob.create({
      data: {
        workspaceId,
        tenantId: dto.tenantId,
        leadId: dto.leadId ?? null,
        siteAddress: dto.siteAddress ?? null,
        siteCity: dto.siteCity ?? null,
        contactName: dto.contactName ?? null,
        contactPhone: dto.contactPhone ?? null,
        notes: dto.notes ?? null,
        status: 'REQUESTED',
      },
    });
  }

  /** Assign a crew + date with an availability (capacity) check. */
  async schedule(workspaceId: string, id: string, dto: ScheduleJobDto) {
    const job = await this.getOrThrow(workspaceId, id);
    if (!SCHEDULABLE_FROM.includes(job.status)) {
      throw new BadRequestException(`Job in status ${job.status} cannot be scheduled`);
    }
    // Scoped read — a crew id from another workspace must not be assignable.
    const crew = await this.prisma.installationCrew.findFirst({
      where: { id: dto.crewId, workspaceId },
    });
    if (!crew || !crew.active) {
      throw new BadRequestException('Crew not found or inactive');
    }
    // Date-only, timezone-stable key so the capacity count and the
    // availability view agree on the calendar day (the @db.Date column).
    const date = toUtcDateOnly(dto.scheduledDate);

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent schedulers for THIS crew so the capacity
      // count-then-write below is atomic. Without the row lock, two parallel
      // schedule() calls each read booked=0 for a capacity-1 crew and both
      // write SCHEDULED → the crew is silently double-booked (there is no
      // @@unique on (crewId, scheduledDate) to catch it). The lock is held to
      // commit, so the second scheduler sees the first job in its count.
      await tx.$queryRaw`SELECT id FROM installation_crews WHERE id = ${dto.crewId} FOR UPDATE`;

      // Availability: crew's occupying jobs on that date (excluding this one)
      // must be below capacity. Mirrors InstallationCrewService.availabilityOn.
      const booked = await tx.installationJob.count({
        where: {
          workspaceId,
          crewId: dto.crewId,
          scheduledDate: date,
          status: { in: OCCUPYING_STATUSES },
          id: { not: id },
        },
      });
      if (booked >= crew.dailyCapacity) {
        throw new ConflictException('Crew is fully booked on that date');
      }

      const row = await tx.installationJob.update({
        where: { id },
        data: {
          crewId: dto.crewId,
          scheduledDate: date,
          scheduledWindow: dto.scheduledWindow ?? null,
          status: 'SCHEDULED',
          scheduledAt: now,
        },
      });
      await this.outbox.append(
        {
          type: MarketingEventTypes.InstallationScheduled,
          tenantId: job.tenantId,
          idempotencyKey: `install-scheduled:${id}:${dto.scheduledDate}`,
          payload: {
            jobId: id,
            tenantId: job.tenantId,
            crewId: dto.crewId,
            scheduledDate: dto.scheduledDate,
            occurredAt: now.toISOString(),
          },
        },
        tx as any,
      );
      return row;
    });
  }

  /** Drive the status machine (IN_PROGRESS / DONE / CANCELLED / NO_SHOW). */
  async setStatus(workspaceId: string, id: string, status: string) {
    const job = await this.getOrThrow(workspaceId, id);
    const allowed = SET_TRANSITIONS[job.status] ?? [];
    if (!allowed.includes(status)) {
      throw new BadRequestException(`Cannot move job from ${job.status} to ${status}`);
    }
    const now = new Date();
    const data: Prisma.InstallationJobUpdateInput = { status };
    if (status === 'IN_PROGRESS') data.startedAt = now;
    if (status === 'DONE') data.completedAt = now;
    // Free the crew slot on abandoned/terminal states. Capacity already
    // excludes these statuses, but unfiltered list views order by crew/date,
    // so a CANCELLED/NO_SHOW job left with crewId+window still reads as
    // "attached" to the crew. Keep scheduledDate for history.
    if (status === 'CANCELLED' || status === 'NO_SHOW') {
      // `crewId` is a soft (no-FK) reference per the Phase-5 marketing
      // decoupling, so disconnect-via-relation isn't available — clear
      // the scalar directly. Same observable effect.
      data.crewId = null;
      data.scheduledWindow = null;
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.installationJob.update({ where: { id }, data });
      if (status === 'DONE') {
        await this.outbox.append(
          {
            type: MarketingEventTypes.InstallationCompleted,
            tenantId: job.tenantId,
            idempotencyKey: `install-completed:${id}`,
            payload: {
              jobId: id,
              tenantId: job.tenantId,
              crewId: job.crewId,
              occurredAt: now.toISOString(),
            },
          },
          tx as any,
        );
      }
      return row;
    });
  }

  async list(workspaceId: string, filter: JobFilterDto) {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 20;
    const filters: Prisma.InstallationJobWhereInput = {};
    if (filter.status) filters.status = filter.status;
    if (filter.crewId) filters.crewId = filter.crewId;
    if (filter.scheduledFrom || filter.scheduledTo) {
      filters.scheduledDate = {};
      if (filter.scheduledFrom) filters.scheduledDate.gte = new Date(filter.scheduledFrom);
      if (filter.scheduledTo) filters.scheduledDate.lte = new Date(filter.scheduledTo);
    }
    const [data, total] = await this.prisma.$transaction([
      this.prisma.installationJob.findMany({
        where: { workspaceId, ...filters },
        orderBy: [{ scheduledDate: 'asc' }, { requestedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { tasks: { orderBy: { position: 'asc' } } },
      }),
      this.prisma.installationJob.count({ where: { workspaceId, ...filters } }),
    ]);
    return paginated(data, total, page, limit);
  }

  async get(workspaceId: string, id: string) {
    const job = await this.prisma.installationJob.findFirst({
      where: { id, workspaceId },
      include: { tasks: { orderBy: { position: 'asc' } } },
    });
    if (!job) throw new NotFoundException('Installation job not found');
    return job;
  }

  // --- tasks (checklist within a job) ---
  // InstallationTask rows carry no workspaceId — they inherit scope from
  // their parent job, so every method below FIRST resolves the job through
  // a workspace-scoped read before touching its tasks.

  async addTask(workspaceId: string, jobId: string, dto: CreateInstallTaskDto) {
    await this.getOrThrow(workspaceId, jobId);
    const position =
      dto.position ??
      (await this.prisma.installationTask.count({
        where: { jobId, job: { workspaceId } },
      }));
    return this.prisma.installationTask.create({
      data: { jobId, title: dto.title, position },
    });
  }

  async toggleTask(workspaceId: string, jobId: string, taskId: string) {
    await this.getOrThrow(workspaceId, jobId);
    const task = await this.prisma.installationTask.findUnique({ where: { id: taskId } });
    if (!task || task.jobId !== jobId) throw new NotFoundException('Task not found for this job');
    return this.prisma.installationTask.update({
      where: { id: taskId },
      data: { done: !task.done },
    });
  }

  async removeTask(workspaceId: string, jobId: string, taskId: string) {
    await this.getOrThrow(workspaceId, jobId);
    const task = await this.prisma.installationTask.findUnique({ where: { id: taskId } });
    if (!task || task.jobId !== jobId) throw new NotFoundException('Task not found for this job');
    await this.prisma.installationTask.delete({ where: { id: taskId } });
    return { deleted: true };
  }

  /** Ops dashboard: status mix, backlog, SLA breaches, and the upcoming week. */
  async dashboard(workspaceId: string) {
    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const slaCutoff = new Date(now.getTime() - SLA_DAYS * 24 * 60 * 60 * 1000);

    // groupBy is awaited standalone — inside a $transaction tuple its `having`
    // return type triggers a TS2615 circular `OR`/`AND`/`NOT` mapped-type error
    // (Prisma 6 typing quirk). Standalone it infers fine. v3.0.1: also expand
    // `_count: true` to `_count: { _all: true }` because Prisma 6's groupBy
    // generic chokes on the literal-true shorthand.
    const byStatusRows = await this.prisma.installationJob.groupBy({
      by: ['status'],
      where: { workspaceId },
      _count: { _all: true },
    });
    const [unscheduled, overdue, upcoming] = await this.prisma.$transaction([
      this.prisma.installationJob.count({ where: { workspaceId, status: 'REQUESTED' } }),
      this.prisma.installationJob.count({
        where: { workspaceId, status: 'REQUESTED', requestedAt: { lt: slaCutoff } },
      }),
      this.prisma.installationJob.findMany({
        where: { workspaceId, status: 'SCHEDULED', scheduledDate: { gte: now, lte: weekAhead } },
        orderBy: { scheduledDate: 'asc' },
        take: 50,
      }),
    ]);

    const byStatus = byStatusRows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = r._count._all;
      return acc;
    }, {});
    return { byStatus, unscheduled, overdueSla: overdue, upcoming };
  }

  private async getOrThrow(workspaceId: string, id: string) {
    const job = await this.prisma.installationJob.findFirst({ where: { id, workspaceId } });
    if (!job) throw new NotFoundException('Installation job not found');
    return job;
  }
}
