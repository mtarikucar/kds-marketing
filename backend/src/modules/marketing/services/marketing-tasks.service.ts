import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateTaskDto } from '../dto/create-task.dto';
import { UpdateTaskDto } from '../dto/update-task.dto';
import { TaskFilterDto } from '../dto/task-filter.dto';
import { zonedParts, zonedWallTimeToUtcMs } from '../sites/timezone-slots';
import { MarketingNotificationsService } from './marketing-notifications.service';
import { OutboxService } from '../../outbox/outbox.service';
import { MarketingEventTypes } from '../events/marketing-event-types';
import { parseDueDate } from './marketing-task-date.util';
import { rangeEndInclusive } from './report-date-range.util';

const MAX_CALENDAR_RANGE_DAYS = 62;

@Injectable()
export class MarketingTasksService {
  private readonly logger = new Logger(MarketingTasksService.name);

  constructor(
    private prisma: PrismaService,
    private notificationsService: MarketingNotificationsService,
    private outbox: OutboxService,
  ) {}

  /** Cross-reference guard: the assignee must live in the actor's workspace. */
  private async assertAssigneeInWorkspace(workspaceId: string, assignedToId: string) {
    const assignee = await this.prisma.marketingUser.findFirst({
      where: { id: assignedToId, workspaceId },
      select: { id: true },
    });
    if (!assignee) throw new NotFoundException('Assigned user not found');
  }

  /** Cross-reference guard: the linked lead must live in the actor's workspace. */
  private async assertLeadInWorkspace(workspaceId: string, leadId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
  }

  async create(workspaceId: string, dto: CreateTaskDto, userId: string) {
    // The actor (userId) is in-workspace by construction (guard-checked);
    // any other assignee and any lead reference must be validated.
    if (dto.assignedToId && dto.assignedToId !== userId) {
      await this.assertAssigneeInWorkspace(workspaceId, dto.assignedToId);
    }
    if (dto.leadId) {
      await this.assertLeadInWorkspace(workspaceId, dto.leadId);
    }

    const task = await this.prisma.marketingTask.create({
      data: {
        workspaceId,
        title: dto.title,
        description: dto.description,
        type: dto.type,
        priority: dto.priority || 'MEDIUM',
        dueDate: parseDueDate(dto.dueDate),
        leadId: dto.leadId,
        assignedToId: dto.assignedToId || userId,
      },
      include: {
        lead: { select: { id: true, businessName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (task.assignedToId !== userId) {
      this.notificationsService.create({
        workspaceId,
        userId: task.assignedToId,
        type: 'TASK_ASSIGNED',
        title: 'New task assigned',
        message: `Task: "${task.title}"`,
        metadata: { taskId: task.id },
      }).catch(() => {});
    }

    return task;
  }

  async findAll(workspaceId: string, filter: TaskFilterDto, userId: string, userRole: string) {
    const page = filter.page || 1;
    const limit = filter.limit || 20;
    const skip = (page - 1) * limit;

    const filters: any = {};

    if (userRole === 'REP') {
      filters.assignedToId = userId;
    } else if (filter.assignedToId) {
      filters.assignedToId = filter.assignedToId;
    }

    if (filter.status) filters.status = filter.status;
    if (filter.type) filters.type = filter.type;
    if (filter.priority) filters.priority = filter.priority;
    if (filter.leadId) filters.leadId = filter.leadId;

    if (filter.dateFrom || filter.dateTo) {
      filters.dueDate = {};
      if (filter.dateFrom) filters.dueDate.gte = new Date(filter.dateFrom);
      // Inclusive end-of-day for a bare YYYY-MM-DD so tasks due later on the
      // final day aren't dropped (mirrors reports/analytics).
      if (filter.dateTo) filters.dueDate.lte = rangeEndInclusive(filter.dateTo);
    }

    const allowedSortFields = ['createdAt', 'updatedAt', 'dueDate', 'title', 'type', 'status', 'priority'];
    const orderBy: any = {};
    if (filter.sortBy && allowedSortFields.includes(filter.sortBy)) {
      orderBy[filter.sortBy] = filter.sortOrder || 'asc';
    } else {
      orderBy.dueDate = 'asc';
    }

    const [tasks, total] = await Promise.all([
      this.prisma.marketingTask.findMany({
        where: { workspaceId, ...filters },
        orderBy,
        skip,
        take: limit,
        include: {
          lead: { select: { id: true, businessName: true } },
          assignedTo: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.marketingTask.count({ where: { workspaceId, ...filters } }),
    ]);

    return {
      data: tasks,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findToday(workspaceId: string, userId: string, userRole: string) {
    // Bound "today" in the WORKSPACE's timezone, not the server's local time. The
    // API runs UTC, so `setHours(0,0,0,0)` yielded UTC — not e.g. Istanbul — day
    // edges, dropping/duplicating tasks due in the first offset-hours of the local
    // day for a Turkey (UTC+3) rep. Mirrors the dashboard periodBounds fix.
    const ws = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { timezone: true },
    });
    const tz = ws?.timezone || 'UTC';
    const { y, mo, d } = zonedParts(Date.now(), tz);
    const today = new Date(zonedWallTimeToUtcMs(y, mo, d, 0, 0, tz));
    const tomorrow = new Date(zonedWallTimeToUtcMs(y, mo, d + 1, 0, 0, tz));

    return this.prisma.marketingTask.findMany({
      where: {
        workspaceId,
        dueDate: { gte: today, lt: tomorrow },
        status: { not: 'CANCELLED' },
        ...(userRole === 'REP' ? { assignedToId: userId } : {}),
      },
      orderBy: { dueDate: 'asc' },
      include: {
        lead: { select: { id: true, businessName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async findOverdue(workspaceId: string, userId: string, userRole: string) {
    const now = new Date();

    return this.prisma.marketingTask.findMany({
      where: {
        workspaceId,
        dueDate: { lt: now },
        status: { in: ['PENDING', 'IN_PROGRESS'] },
        ...(userRole === 'REP' ? { assignedToId: userId } : {}),
      },
      orderBy: { dueDate: 'asc' },
      include: {
        lead: { select: { id: true, businessName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async findCalendar(
    workspaceId: string,
    dateFrom: string,
    dateTo: string,
    userId: string,
    userRole: string,
  ) {
    const from = new Date(dateFrom);
    const to = new Date(dateTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date range');
    }
    if (from > to) {
      throw new BadRequestException('dateFrom must be <= dateTo');
    }
    const rangeDays = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
    if (rangeDays > MAX_CALENDAR_RANGE_DAYS) {
      throw new BadRequestException(
        `Calendar range cannot exceed ${MAX_CALENDAR_RANGE_DAYS} days`,
      );
    }

    return this.prisma.marketingTask.findMany({
      where: {
        workspaceId,
        dueDate: { gte: from, lte: to },
        ...(userRole === 'REP' ? { assignedToId: userId } : {}),
      },
      orderBy: { dueDate: 'asc' },
      take: 500,
      include: {
        lead: { select: { id: true, businessName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async findOne(workspaceId: string, id: string, userId: string, userRole: string) {
    const task = await this.prisma.marketingTask.findFirst({
      where: { id, workspaceId },
      include: {
        lead: { select: { id: true, businessName: true, contactPerson: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!task) throw new NotFoundException('Task not found');

    if (userRole === 'REP' && task.assignedToId !== userId) {
      throw new ForbiddenException('You can only view your own tasks');
    }

    return task;
  }

  async update(workspaceId: string, id: string, dto: UpdateTaskDto, userId: string, userRole: string) {
    const task = await this.prisma.marketingTask.findFirst({ where: { id, workspaceId } });

    if (!task) throw new NotFoundException('Task not found');

    if (userRole === 'REP' && task.assignedToId !== userId) {
      throw new ForbiddenException('You can only update your own tasks');
    }

    // Re-validate cross-references when the update rewires them.
    if (dto.assignedToId && dto.assignedToId !== userId) {
      await this.assertAssigneeInWorkspace(workspaceId, dto.assignedToId);
    }
    if (dto.leadId) {
      await this.assertLeadInWorkspace(workspaceId, dto.leadId);
    }

    const { status, ...rest } = dto;
    const data: any = { ...rest };
    // COMPLETED is owned by complete() — the atomic claim + the task.completed
    // workflow trigger. The generic editor must NOT silently complete a task and
    // skip that side effect; other status moves (IN_PROGRESS/CANCELLED) are fine.
    if (status && status !== 'COMPLETED') data.status = status;
    if (dto.dueDate) data.dueDate = parseDueDate(dto.dueDate);

    const updated = await this.prisma.marketingTask.update({
      where: { id: task.id },
      data,
      include: {
        lead: { select: { id: true, businessName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    // Notify the new assignee on a reassignment (mirrors create()). create()
    // already covers first assignment; here only fire when the assignee actually
    // CHANGED to someone other than the actor — the most common assign path.
    if (dto.assignedToId && dto.assignedToId !== task.assignedToId && dto.assignedToId !== userId) {
      this.notificationsService.create({
        workspaceId,
        userId: dto.assignedToId,
        type: 'TASK_ASSIGNED',
        title: 'Task assigned to you',
        message: `Task: "${updated.title}"`,
        metadata: { taskId: updated.id },
      }).catch(() => {});
    }

    return updated;
  }

  async complete(workspaceId: string, id: string, userId: string, userRole: string) {
    const task = await this.prisma.marketingTask.findFirst({ where: { id, workspaceId } });

    if (!task) throw new NotFoundException('Task not found');

    if (userRole === 'REP' && task.assignedToId !== userId) {
      throw new ForbiddenException('You can only complete your own tasks');
    }

    const updated = await this.prisma.marketingTask.update({
      where: { id: task.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    // Fire the `task.completed` workflow trigger (the event was never emitted,
    // so task-completion automations were dead). Only on a real transition into
    // COMPLETED; best-effort — never fail the completion on an outbox hiccup.
    if (task.status !== 'COMPLETED') {
      await this.outbox
        .append({
          type: MarketingEventTypes.TaskCompleted,
          idempotencyKey: `task-completed:${task.id}`,
          payload: {
            workspaceId,
            taskId: task.id,
            leadId: task.leadId ?? null,
            occurredAt: new Date().toISOString(),
          },
        })
        .catch((e) =>
          this.logger.warn(
            `task.completed outbox append failed for ${task.id}: ${(e as Error).message}`,
          ),
        );
    }
    return updated;
  }

  async delete(workspaceId: string, id: string, userId: string, userRole: string) {
    const task = await this.prisma.marketingTask.findFirst({ where: { id, workspaceId } });

    if (!task) throw new NotFoundException('Task not found');

    if (userRole === 'REP' && task.assignedToId !== userId) {
      throw new ForbiddenException('You can only delete your own tasks');
    }

    await this.prisma.marketingTask.delete({ where: { id: task.id } });
    return { message: 'Task deleted successfully' };
  }
}
