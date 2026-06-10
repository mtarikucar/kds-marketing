import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class MarketingNotificationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * Creation helper for in-module producers. The recipient user row is the
   * scope anchor: when the caller doesn't pass a `workspaceId` (e.g. it only
   * holds a user id), it is derived from the recipient; when it does, a
   * cross-workspace (workspaceId, userId) pair is rejected as "not found".
   * Either way the row is born scoped to the recipient's workspace.
   */
  async create(data: {
    workspaceId?: string;
    userId: string;
    type: string;
    title: string;
    message: string;
    metadata?: any;
  }) {
    const { workspaceId, ...rest } = data;
    const recipient = await this.prisma.marketingUser.findUnique({
      where: { id: data.userId },
      select: { workspaceId: true },
    });
    if (!recipient || (workspaceId && recipient.workspaceId !== workspaceId)) {
      throw new NotFoundException('Notification recipient not found');
    }

    return this.prisma.marketingNotification.create({
      data: { ...rest, workspaceId: recipient.workspaceId },
    });
  }

  async findAll(workspaceId: string, userId: string, isRead?: boolean) {
    const isReadFilter = isRead !== undefined ? { isRead } : {};

    return this.prisma.marketingNotification.findMany({
      where: { workspaceId, userId, ...isReadFilter },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async markRead(workspaceId: string, id: string, userId: string) {
    const notification = await this.prisma.marketingNotification.findFirst({
      where: { id, workspaceId, userId },
    });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    return this.prisma.marketingNotification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async markAllRead(workspaceId: string, userId: string) {
    await this.prisma.marketingNotification.updateMany({
      where: { workspaceId, userId, isRead: false },
      data: { isRead: true },
    });
    return { message: 'All notifications marked as read' };
  }

  async getUnreadCount(workspaceId: string, userId: string) {
    const count = await this.prisma.marketingNotification.count({
      where: { workspaceId, userId, isRead: false },
    });
    return { count };
  }
}
