import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateTaskDto } from '../dto/create-task.dto';
import { UpdateTaskDto } from '../dto/update-task.dto';
import { TaskFilterDto } from '../dto/task-filter.dto';
import { MarketingNotificationsService } from './marketing-notifications.service';

// Allow a small grace for clock skew before rejecting a dueDate as
// "in the past". 5 minutes is enough for any sane client drift.
const PAST_DUE_GRACE_MS = 5 * 60 * 1000;
const MAX_CALENDAR_RANGE_DAYS = 62;

@Injectable()
export class MarketingTasksService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: MarketingNotificationsService,
  ) {}

  private assertDueDateNotInPast(dueDate: Date | string): Date {
    const d = new Date(dueDate);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('Invalid dueDate');
    }
    if (d.getTime() < Date.now() - PAST_DUE_GRACE_MS) {
      throw new BadRequestException('dueDate must not be in the past');
    }
    return d;
  }

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
        dueDate: this.assertDueDateNotInPast(dto.dueDate),
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
      if (filter.dateTo) filters.dueDate.lte = new Date(filter.dateTo);
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

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

    const data: any = { ...dto };
    if (dto.dueDate) data.dueDate = new Date(dto.dueDate);

    return this.prisma.marketingTask.update({
      where: { id: task.id },
      data,
      include: {
        lead: { select: { id: true, businessName: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async complete(workspaceId: string, id: string, userId: string, userRole: string) {
    const task = await this.prisma.marketingTask.findFirst({ where: { id, workspaceId } });

    if (!task) throw new NotFoundException('Task not found');

    if (userRole === 'REP' && task.assignedToId !== userId) {
      throw new ForbiddenException('You can only complete your own tasks');
    }

    return this.prisma.marketingTask.update({
      where: { id: task.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
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
