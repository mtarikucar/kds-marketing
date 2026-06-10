import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateActivityDto } from '../dto/create-activity.dto';

@Injectable()
export class MarketingActivitiesService {
  constructor(private prisma: PrismaService) {}

  async create(
    workspaceId: string,
    leadId: string,
    dto: CreateActivityDto,
    userId: string,
    userRole: string,
  ) {
    // Activities may only be created on a lead in the caller's
    // workspace — resolve the lead scoped first; the activity row then
    // inherits that scope through its leadId.
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
    });

    if (!lead) {
      throw new NotFoundException('Lead not found');
    }

    if (userRole === 'REP' && lead.assignedToId !== userId) {
      throw new ForbiddenException('You can only add activities to your own leads');
    }

    return this.prisma.leadActivity.create({
      data: {
        ...dto,
        leadId,
        createdById: userId,
      },
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async findByLead(workspaceId: string, leadId: string, userId: string, userRole: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, workspaceId },
    });

    if (!lead) {
      throw new NotFoundException('Lead not found');
    }

    if (userRole === 'REP' && lead.assignedToId !== userId) {
      throw new ForbiddenException('You can only view activities for your own leads');
    }

    return this.prisma.leadActivity.findMany({
      // The scoped lead read above already proves leadId is ours; the
      // relation filter keeps the query itself workspace-tight too.
      where: { leadId, lead: { workspaceId } },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async delete(workspaceId: string, id: string) {
    // LeadActivity carries no workspaceId column — its scope is the
    // parent lead, so the pre-check walks the relation.
    const activity = await this.prisma.leadActivity.findFirst({
      where: { id, lead: { workspaceId } },
    });
    if (!activity) throw new NotFoundException('Activity not found');

    await this.prisma.leadActivity.delete({ where: { id: activity.id } });
    return { message: 'Activity deleted successfully' };
  }
}
